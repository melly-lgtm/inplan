// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Desktop loader for runtime editor plugins. Open-core ships this loader but none of the plugin
// code: it asks the plugin server whether the user is entitled, verifies the signed bundle
// (resolveDesktopPlugin — Ed25519 + sha384 vs the baked-in public key), and only then dynamically
// imports it. The plugin's Node entry runs here (it returns an opaque session string); the verified
// browser entry is served to the renderer over a privileged scheme so the renderer can import() it
// under CSP. Anything not entitled / offline-expired / unverified ⇒ no session, no scheme content
// ⇒ the editor runs without the plugin. The loader knows nothing about what the plugin does.

import { protocol } from "electron";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { docPaths, readStatus, resolveDesktopPlugin, writeStatus } from "@inplan/core/node";

/** Plugin server HTTP base (ws→http), for the entitlement check. */
const PLUGIN_HTTP = (process.env.INPLAN_PLUGIN_URL || "wss://inplan-collab.fly.dev").replace(/^ws/, "http");
// The plugin-signing public key (SPKI PEM), baked into THIS bundle at build time by electron-vite's
// `define` (the release sets INPLAN_PLUGIN_PUBLIC_KEY); a dev env var works otherwise. We pass it to
// the verifier explicitly because @inplan/core is external to the app bundle, so a define can't
// reach it. Empty ⇒ nothing verifies ⇒ no plugin (fail-closed).
const PUBLIC_KEY = process.env.INPLAN_PLUGIN_PUBLIC_KEY ?? "";
const SCHEME = "inplan-plugin";
const cacheDir = (): string => join(process.env.INPLAN_HOME || join(homedir(), ".inplan"), "plugin-cache");

/** The plugin's Node (main) entry contract: start it for a doc, get back an opaque session string
 *  (e.g. a loopback endpoint) the renderer + CLI use, and a stop handle. Open-core never interprets
 *  the session. */
interface MainEntry {
  start: (file: string) => Promise<{ session: string; stop: () => Promise<void> }>;
}
interface PluginState {
  file: string; // the doc this plugin instance serves (so we clear its status on stop)
  session: string;
  rendererPath: string; // verified local path of the renderer entry (served over the scheme)
  stop: () => Promise<void>;
}
let state: PluginState | null = null;
// The verified bundle is the SAME across docs (it's the user's entitlement, not per-doc), and the
// signed-bundle resolve is expensive (network entitlement check + re-download + signature verify).
// Resolve it ONCE per process and reuse it on every navigation — only the per-doc hub (`mod.start`)
// restarts. Cleared only on an explicit reset (re-login/relaunch handles a changed entitlement).
let resolvedBundle: { mod: MainEntry; rendererPath: string } | null = null;

/** Publish/clear the plugin session on the doc's status sidecar so the CLI (a separate process) can
 *  hand it back to the plugin and gate the agent through it. Merge so we never drop the doc's other
 *  status fields (location / originalPath / cloud pointers). Best-effort. */
function setStatusSession(file: string, session: string | undefined): void {
  try {
    const { statusPath } = docPaths(file);
    const st = readStatus(statusPath);
    if (session) writeStatus(statusPath, { ...st, pluginSession: session });
    else {
      const { pluginSession: _drop, ...rest } = st;
      writeStatus(statusPath, rest);
    }
  } catch {
    /* a status write failure just means the CLI stays on the file-backed path */
  }
}

/** Register the privileged scheme. MUST run before app 'ready' (Electron requirement). */
export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
}

/** Serve the *currently-verified* renderer-entry bytes over the scheme. Call once in whenReady. The
 *  renderer imports `inplan-plugin://bundle/renderer.js`; we only ever serve a path main verified. */
export function handlePluginScheme(): void {
  protocol.handle(SCHEME, () => {
    if (!state) return new Response("", { status: 404 });
    return new Response(readFileSync(state.rendererPath), { headers: { "content-type": "text/javascript" } });
  });
}

/** The info the renderer needs (the plugin session + the scheme URL to import), or null. */
export function pluginInfo(): { session: string; rendererUrl: string } | null {
  return state ? { session: state.session, rendererUrl: `${SCHEME}://bundle/renderer.js` } : null;
}

/** Entitlement-gated: load + verify the plugin bundle for `file`, run its main entry, and publish
 *  the session. Fail-soft — any failure (not entitled / offline-expired / unverified / start error)
 *  leaves `state` null so the editor runs without the plugin. `getToken` mints the user's token. */
export async function startDesktopPlugin(file: string, getToken: () => Promise<string | null>): Promise<void> {
  await stopDesktopPlugin();
  try {
    // Resolve + verify the bundle once; reuse it for later navigations (only the hub restarts).
    if (!resolvedBundle) {
      const token = await getToken();
      const bundle = await resolveDesktopPlugin({ apiBase: PLUGIN_HTTP, token, cacheDir: cacheDir(), publicKey: PUBLIC_KEY });
      const mainName = bundle?.entries.main;
      const rendererName = bundle?.entries.renderer;
      if (!bundle || !mainName || !rendererName || !bundle.files[mainName] || !bundle.files[rendererName]) return; // not entitled / unverified
      const mod = (await import(pathToFileURL(bundle.files[mainName]).href)) as MainEntry;
      resolvedBundle = { mod, rendererPath: bundle.files[rendererName] };
    }
    const started = await resolvedBundle.mod.start(file);
    state = { file, session: started.session, rendererPath: resolvedBundle.rendererPath, stop: () => started.stop() };
    setStatusSession(file, started.session); // let the CLI gate through the plugin
    process.stderr.write(`[inplan] desktop plugin active for ${file}\n`);
  } catch (e) {
    process.stderr.write(`[inplan] desktop plugin unavailable (running without it): ${e instanceof Error ? e.message : String(e)}\n`);
    state = null;
  }
}

export async function stopDesktopPlugin(): Promise<void> {
  const s = state;
  state = null;
  if (s) {
    setStatusSession(s.file, undefined); // the plugin is gone — the CLI must fall back to the file
    await s.stop().catch(() => {});
  }
}
