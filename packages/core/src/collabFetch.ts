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
import { isAbsolute, join, relative, resolve } from "node:path";
import { COLLAB_PUBLIC_KEY, verifyBundleBytes, verifyLease, type BundleManifestEntry, type LeaseClaims } from "./collabLoader";

interface Manifest {
  version: string;
  files: BundleManifestEntry[];
}

/** Join `child` under `root`, returning null if it escapes the root. The manifest's `version` and
 *  each `entry.name` are server-supplied strings; a `../` segment must never let a cache read/write
 *  land outside the cache root (path traversal), even though the file *bytes* are signature-checked. */
function safeJoin(root: string, child: string): string | null {
  const rootPath = resolve(root);
  const full = resolve(rootPath, child);
  const rel = relative(rootPath, full);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)) ? full : null;
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
    const dir = safeJoin(cacheDir, version);
    if (!dir) return null; // version escapes the cache root
    const leaseToken = readFileSync(join(dir, "lease.txt"), "utf8").trim();
    const lease = verifyLease(leaseToken, publicKey, now);
    if (!lease) return null;
    const manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
    const files: Record<string, string> = {};
    for (const entry of manifest.files) {
      const path = safeJoin(dir, entry.name);
      if (!path || !existsSync(path)) return null; // name escapes the version dir / missing
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
  const dir = safeJoin(opts.cacheDir, manifest.version);
  if (!dir) return null; // version escapes the cache root
  mkdirSync(dir, { recursive: true });
  // The bundle files are ESM (format:"esm") but named `.js`; Node treats a bare `.js` as CJS unless
  // the nearest package.json says otherwise, so a Node-side `import()` of hub.js/peer.js would throw
  // on `export`. Mark the cache dir as an ESM scope so they load as modules. (desktop.js is imported
  // by the renderer over a scheme — browser ESM by MIME — so this only matters for the Node files.)
  writeFileSync(join(dir, "package.json"), '{"type":"module"}\n');
  for (const entry of manifest.files) {
    const filePath = safeJoin(dir, entry.name);
    if (!filePath) return null; // name escapes the version dir
    const r = await opts.fetchImpl(`${root}${entry.name}`);
    if (!r.ok) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (!verifyBundleBytes(bytes, entry, opts.publicKey)) return null; // refuse to cache unverified bytes
    writeFileSync(filePath, bytes);
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
        if (grant.entitled && grant.lease && grant.bundleUrl) {
          // A positive grant ships a fresh, signed lease. A lease that fails verification is a
          // tampering signal — fail closed rather than silently using the cache. (A transient
          // bundle-CDN miss still falls through to the independently re-verified cache below.)
          if (!verifyLease(grant.lease, publicKey, now)) return null;
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
