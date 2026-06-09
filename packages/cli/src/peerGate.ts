// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI loader for the paid live-collab peer (Stage 3c/2d). When the desktop editor publishes a
// loopback hub URL on the doc's status (`status.hubUrl`) AND the user is entitled, the CLI joins
// that hub as a peer and gates the agent through the LIVE doc instead of the `.md` — so an agent
// edit lands in the same shared document the human is editing in the editor. Open-core ships only
// this loader; the peer code (***REMOVED*** / hub transport) lives in the signature-verified bundle that
// `resolveDesktopCollab` fetches + verifies before we `import()` it. Not entitled / unverified /
// no peer in the bundle ⇒ null ⇒ the caller stays on the file-backed gate.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopCollab } from "@inplan/core/node";

/** Collab server HTTP base (ws→http), shared with the desktop app's entitlement check. */
const COLLAB_HTTP = (process.env.INPLAN_COLLAB_URL || "wss://inplan-collab.fly.dev").replace(/^ws/, "http");
/** The same cache root the app uses, so a bundle fetched by either side is reused (and re-verified). */
const defaultCacheDir = (): string => join(process.env.INPLAN_HOME || join(homedir(), ".inplan"), "collab-cache");
/** How long a single hub read/apply may take before we give up (a stale URL ⇒ fall back to file). */
const HUB_TIMEOUT_MS = 2500;

/** The hub-backed gate the wait loop uses in place of file reads/writes. */
export interface HubGate {
  /** The hub's live projection — the gate's canonical base (instead of reading the `.md`). */
  readCanonical(): Promise<string>;
  /** Push the accepted markdown into the live doc (the hub owns the `.md`). */
  applyRevision(markdown: string): Promise<void>;
}

/** The shape of the verified peer bundle (cloud collab-client `./peer`). */
interface PeerModule {
  readDocViaHub(url: string, opts?: { timeoutMs?: number }): Promise<string>;
  applyRevisionViaHub(url: string, markdown: string, opts?: { timeoutMs?: number }): Promise<void>;
}

/** Injectable seams so the wait path is unit-testable without a real signed bundle / live hub. */
export interface PeerGateDeps {
  resolve: typeof resolveDesktopCollab;
  importPeer: (path: string) => Promise<PeerModule>;
}
const defaultDeps: PeerGateDeps = {
  resolve: resolveDesktopCollab,
  importPeer: (p) => import(pathToFileURL(p).href) as Promise<PeerModule>,
};

export interface LoadHubGateOptions {
  /** The user's JWT (from `authedSession`), or null when logged out (⇒ offline cache only). */
  token: string | null;
  apiBase?: string;
  cacheDir?: string;
  publicKey?: string;
}

/**
 * Load the entitlement-gated, signature-verified peer for `hubUrl`. Returns a {@link HubGate} when
 * the user is entitled and the verified bundle ships a peer; otherwise null (⇒ file-backed gate).
 * Fail-soft: any verify / fetch / import failure returns null. The hub's own reachability is the
 * gate's concern — its read/apply time out, and the caller falls back to the file on a thrown read.
 */
export async function loadHubGate(hubUrl: string, options: LoadHubGateOptions, deps: PeerGateDeps = defaultDeps): Promise<HubGate | null> {
  try {
    const bundle = await deps.resolve({
      apiBase: options.apiBase ?? COLLAB_HTTP,
      token: options.token,
      cacheDir: options.cacheDir ?? defaultCacheDir(),
      ...(options.publicKey ? { publicKey: options.publicKey } : {}),
    });
    const peerPath = bundle?.files["peer.js"];
    if (!peerPath) return null; // not entitled / unverified / no peer in the bundle
    const peer = await deps.importPeer(peerPath);
    return {
      readCanonical: () => peer.readDocViaHub(hubUrl, { timeoutMs: HUB_TIMEOUT_MS }),
      applyRevision: (md) => peer.applyRevisionViaHub(hubUrl, md, { timeoutMs: HUB_TIMEOUT_MS }),
    };
  } catch {
    return null; // any failure ⇒ turn-only / file-backed
  }
}
