// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Desktop collab plugin: fetch → verify → cache (the orchestration around the verify core). Used
// by the app main and the CLI. Open-core ships this loader but NEVER the plugin code — it only
// runs a bundle whose Ed25519 signature + sha384 validate against the baked-in public key.
//
// Flow: ask the collab server (with the user's JWT) whether this user is entitled; if so, verify
// the short-lived lease, fetch the signed bundle, verify every file, and cache it under
// `<cacheDir>/<version>/`. Offline, fall back to the cached bundle while its lease is unexpired —
// so a lapsed subscription stops the perk within one lease window. Anything unverified / not
// entitled / expired ⇒ null (the caller falls back to the turn-only file editor).
//
// SECURITY: cached files are RE-VERIFIED on every load (we never trust a cached path alone), and
// `import()` of any file must be gated on this returning it. fs + network; node:crypto via the
// verify core. Import from `@inplan/core/node`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { COLLAB_PUBLIC_KEY, verifyBundleBytes, verifyLease, type BundleManifestEntry, type LeaseClaims } from "./collabLoader";

interface Manifest {
  version: string;
  files: BundleManifestEntry[];
}

export interface ResolvedCollab {
  /** The verified entitlement lease. */
  lease: LeaseClaims;
  /** Bundle version (cache subdir). */
  version: string;
  /** Verified local paths by file name (e.g. { "hub.js": "/…/hub.js" }). Safe to import(). */
  files: Record<string, string>;
}

export interface ResolveCollabOptions {
  /** Collab HTTP base, e.g. "https://inplan-collab.fly.dev" (ws→http already mapped). */
  apiBase: string;
  /** The user's Supabase JWT (from `inplan token`), or null when logged out. */
  token: string | null;
  /** Cache root, e.g. `<INPLAN_HOME>/collab-cache`. */
  cacheDir: string;
  /** Defaults to the baked-in COLLAB_PUBLIC_KEY. */
  publicKey?: string;
  now?: number;
  /** Injectable fetch (tests). */
  fetchImpl?: typeof fetch;
}

const base = (u: string): string => (u.endsWith("/") ? u : `${u}/`);

/** Read a cached bundle version and RE-VERIFY it (lease + every file) before returning. Returns
 *  null if the lease is missing/expired/invalid or any file fails verification (tampered cache). */
function loadCached(cacheDir: string, version: string, publicKey: string, now: number): ResolvedCollab | null {
  try {
    const dir = join(cacheDir, version);
    const leaseToken = readFileSync(join(dir, "lease.txt"), "utf8").trim();
    const lease = verifyLease(leaseToken, publicKey, now);
    if (!lease) return null;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const files: Record<string, string> = {};
    for (const entry of manifest.files) {
      const path = join(dir, entry.name);
      if (!existsSync(path)) return null;
      if (!verifyBundleBytes(readFileSync(path), entry, publicKey)) return null; // re-verify, never trust the path
      files[entry.name] = path;
    }
    return { lease, version, files };
  } catch {
    return null;
  }
}

/** Fetch the manifest + each file, verifying every file before writing, then cache the lease +
 *  manifest + files under <cacheDir>/<version>/ and record it as current. Returns the version, or
 *  null on any fetch / verification failure (nothing unverified is ever cached or returned). */
async function fetchAndCache(bundleUrl: string, leaseToken: string, opts: Required<Pick<ResolveCollabOptions, "cacheDir" | "publicKey" | "fetchImpl">>): Promise<string | null> {
  const root = base(bundleUrl);
  const mres = await opts.fetchImpl(`${root}manifest.json`);
  if (!mres.ok) return null;
  const manifest = (await mres.json()) as Manifest;
  if (!manifest?.version || !Array.isArray(manifest.files)) return null;
  const dir = join(opts.cacheDir, manifest.version);
  mkdirSync(dir, { recursive: true });
  for (const entry of manifest.files) {
    const r = await opts.fetchImpl(`${root}${entry.name}`);
    if (!r.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!verifyBundleBytes(bytes, entry, opts.publicKey)) return null; // refuse to cache unverified bytes
    writeFileSync(join(dir, entry.name), bytes);
  }
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest));
  writeFileSync(join(dir, "lease.txt"), leaseToken);
  writeFileSync(join(opts.cacheDir, "current.txt"), manifest.version);
  return manifest.version;
}

/**
 * Resolve the desktop collab bundle for this user: prefer a fresh server check (catches a lapsed
 * sub), fall back to the cached bundle offline. Returns the verified lease + local file paths, or
 * null (⇒ turn-only). Fail-closed on every error / missing public key.
 */
export async function resolveDesktopCollab(options: ResolveCollabOptions): Promise<ResolvedCollab | null> {
  const publicKey = options.publicKey ?? COLLAB_PUBLIC_KEY;
  const now = options.now ?? Date.now();
  const fetchImpl = options.fetchImpl ?? fetch;
  if (!publicKey) return null; // nothing can be verified ⇒ turn-only

  // 1. Online check (only when we have a token).
  if (options.token) {
    try {
      const res = await fetchImpl(`${base(options.apiBase)}api/v1/desktop-collab`, { headers: { authorization: `Bearer ${options.token}` } });
      if (res.ok) {
        const grant = (await res.json()) as { entitled?: boolean; lease?: string; bundleUrl?: string };
        if (grant.entitled === false) return null; // server says no — don't fall back to a stale cache
        if (grant.entitled && grant.lease && grant.bundleUrl && verifyLease(grant.lease, publicKey, now)) {
          const version = await fetchAndCache(grant.bundleUrl, grant.lease, { cacheDir: options.cacheDir, publicKey, fetchImpl });
          if (version) return loadCached(options.cacheDir, version, publicKey, now);
        }
      }
    } catch {
      /* offline / server error — fall through to the cache */
    }
  }

  // 2. Offline (or the online path didn't yield a bundle): use the cached version while its lease holds.
  try {
    const current = readFileSync(join(options.cacheDir, "current.txt"), "utf8").trim();
    return current ? loadCached(options.cacheDir, current, publicKey, now) : null;
  } catch {
    return null;
  }
}
