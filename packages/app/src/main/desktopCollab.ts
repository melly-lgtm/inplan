// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Desktop loader for the paid live-collab plugin (Stage 3c/2). Open-core ships this loader but
// none of the plugin code: it asks the collab server whether the user is entitled, verifies the
// signed bundle (resolveDesktopCollab — Ed25519 + sha384 vs the baked-in public key), and only
// then dynamically imports it. The Node hub bundle runs here (it hosts the local ***REMOVED*** hub); the
// verified browser bundle (desktop.js) is served to the renderer over a privileged scheme so the
// renderer can import() it under CSP. Anything not entitled / offline-expired / unverified ⇒ no
// hub, no scheme content ⇒ the editor stays the turn-only file editor.

import { protocol } from "electron";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopCollab } from "@inplan/core/node";

/** Collab server HTTP base (ws→http), for the entitlement check. */
const COLLAB_HTTP = (process.env.INPLAN_COLLAB_URL || "wss://inplan-collab.fly.dev").replace(/^ws/, "http");
// The inplan signing public key (SPKI PEM), baked into THIS bundle at build time by electron-vite's
// `define` (the release sets INPLAN_COLLAB_PUBLIC_KEY); a dev env var works otherwise. We pass it to
// the verifier explicitly because @inplan/core is external to the app bundle, so a define can't
// reach it. Empty ⇒ nothing verifies ⇒ turn-only (fail-closed).
const PUBLIC_KEY = process.env.INPLAN_COLLAB_PUBLIC_KEY ?? "";
const SCHEME = "inplan-collab";
const cacheDir = (): string => join(process.env.INPLAN_HOME || join(homedir(), ".inplan"), "collab-cache");

interface HubModule {
  startLocalHub: (file: string) => Promise<{ url: string; stop: () => Promise<void> }>;
}
interface CollabState {
  hubUrl: string;
  desktopPath: string; // verified local path of desktop.js (served over the scheme)
  stop: () => Promise<void>;
}
let state: CollabState | null = null;

/** Register the privileged scheme. MUST run before app 'ready' (Electron requirement). */
export function registerCollabScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** Serve the *currently-verified* desktop.js bytes over the scheme. Call once in whenReady. The
 *  renderer imports `inplan-collab://bundle/desktop.js`; we only ever serve a path main verified. */
export function handleCollabScheme(): void {
  protocol.handle(SCHEME, () => {
    if (!state) return new Response("", { status: 404 });
    return new Response(readFileSync(state.desktopPath), { headers: { "content-type": "text/javascript" } });
  });
}

/** The connection info the renderer needs (hub ws URL + the scheme URL to import), or null. */
export function collabInfo(): { hubUrl: string; desktopUrl: string } | null {
  return state ? { hubUrl: state.hubUrl, desktopUrl: `${SCHEME}://bundle/desktop.js` } : null;
}

/** Entitlement-gated: load + verify the bundle for `file` and host the local hub. Fail-soft —
 *  any failure (not entitled / offline-expired / unverified / hub error) leaves `state` null so
 *  the editor falls back to turn-only. `getToken` mints the user's JWT (the CLI's `token`). */
export async function startDesktopCollab(file: string, getToken: () => Promise<string | null>): Promise<void> {
  await stopDesktopCollab();
  try {
    const token = await getToken();
    const bundle = await resolveDesktopCollab({ apiBase: COLLAB_HTTP, token, cacheDir: cacheDir(), publicKey: PUBLIC_KEY });
    if (!bundle?.files["hub.js"] || !bundle.files["desktop.js"]) return; // not entitled / unverified
    const hubMod = (await import(pathToFileURL(bundle.files["hub.js"]).href)) as HubModule;
    const hub = await hubMod.startLocalHub(file);
    state = { hubUrl: hub.url, desktopPath: bundle.files["desktop.js"], stop: () => hub.stop() };
    process.stderr.write(`[inplan] desktop live-collab active for ${file}\n`);
  } catch (e) {
    process.stderr.write(`[inplan] desktop collab unavailable (file-backed): ${e instanceof Error ? e.message : String(e)}\n`);
    state = null;
  }
}

export async function stopDesktopCollab(): Promise<void> {
  const s = state;
  state = null;
  if (s) await s.stop().catch(() => {});
}
