// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI loader for a runtime plugin's gate (Stage 3c/2d). When the desktop editor publishes a plugin
// session on the doc's status (`status.pluginSession`) AND the user is entitled, the CLI loads the
// plugin's verified CLI entry and gates the agent through the plugin instead of the `.md` — so an
// agent edit lands in whatever shared document the plugin manages. Open-core ships only this loader;
// the plugin code lives in the signature-verified bundle that `resolveDesktopPlugin` fetches +
// verifies before we `import()` it. Not entitled / unverified / no CLI entry ⇒ null ⇒ the caller
// stays on the file-backed gate. Open-core never interprets the session string.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolveDesktopPlugin } from "@inplan/core/node";

/** Plugin server HTTP base (ws→http), shared with the desktop app's entitlement check. */
const PLUGIN_HTTP = (process.env.INPLAN_PLUGIN_URL || "wss://inplan-collab.fly.dev").replace(/^ws/, "http");
/** The same cache root the app uses, so a bundle fetched by either side is reused (and re-verified). */
const defaultCacheDir = (): string => join(process.env.INPLAN_HOME || join(homedir(), ".inplan"), "plugin-cache");

/** The plugin-backed gate the wait loop uses in place of file reads/writes. */
export interface PluginGate {
  /** The plugin's live projection — the gate's canonical base (instead of reading the `.md`). */
  readCanonical(): Promise<string>;
  /** Push the accepted markdown into the plugin's document (the plugin owns the `.md`). */
  applyRevision(markdown: string): Promise<void>;
}

/** The shape of the verified plugin CLI entry: `gate(session)` returns the gate the wait loop uses. */
interface CliEntry {
  gate(session: string): PluginGate;
}

/** Injectable seams so the wait path is unit-testable without a real signed bundle / live plugin. */
export interface PluginGateDeps {
  resolve: typeof resolveDesktopPlugin;
  importCli: (path: string) => Promise<CliEntry>;
}
const defaultDeps: PluginGateDeps = {
  resolve: resolveDesktopPlugin,
  importCli: (p) => import(pathToFileURL(p).href) as Promise<CliEntry>,
};

export interface LoadPluginGateOptions {
  /** The user's token (from `authedSession`), or null when logged out (⇒ offline cache only). */
  token: string | null;
  apiBase?: string;
  cacheDir?: string;
  publicKey?: string;
}

/**
 * Load the entitlement-gated, signature-verified plugin gate for `session`. Returns a
 * {@link PluginGate} when the user is entitled and the verified bundle ships a CLI entry; otherwise
 * null (⇒ file-backed gate). Fail-soft: any verify / fetch / import failure returns null. The
 * plugin owns reachability — its read/apply time out, and the caller falls back to the file.
 */
export async function loadPluginGate(session: string, options: LoadPluginGateOptions, deps: PluginGateDeps = defaultDeps): Promise<PluginGate | null> {
  try {
    const bundle = await deps.resolve({
      apiBase: options.apiBase ?? PLUGIN_HTTP,
      token: options.token,
      cacheDir: options.cacheDir ?? defaultCacheDir(),
      ...(options.publicKey ? { publicKey: options.publicKey } : {}),
    });
    const cliName = bundle?.entries.cli;
    const cliPath = cliName ? bundle?.files[cliName] : undefined;
    if (!cliPath) return null; // not entitled / unverified / no CLI entry in the bundle
    const cli = await deps.importCli(cliPath);
    return cli.gate(session);
  } catch {
    return null; // any failure ⇒ file-backed
  }
}
