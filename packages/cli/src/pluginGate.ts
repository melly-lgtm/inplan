// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CLI loader for a runtime plugin's gate (Stage 3c/2d). When the desktop editor publishes a plugin
// session on the doc's status (`status.pluginSession`) AND the user is entitled, the CLI loads the
// plugin's verified CLI entry and gates the agent through the plugin instead of the `.md` — so an
// agent edit lands in whatever shared document the plugin manages. Open-core ships only this loader;
// the plugin code lives in the signature-verified bundle that `resolvePluginOutcome` fetches +
// verifies before we `import()` it. Not entitled / unverified / no CLI entry ⇒ no gate ⇒ the caller
// either stays on the file-backed gate (local docs) or explains itself and stops (cloud docs, which
// have no file to fall back to). Open-core never interprets the session string.

import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePluginOutcome, type PluginAbsenceReason } from "@inplan/core/node";

export type { PluginAbsenceReason };

/** Default collab hub websocket URL. */
export const DEFAULT_HUB_URL = "wss://inplan-collab.fly.dev";
/** THE single hub-URL resolution order, shared by the gate/edits (cli.ts), presence (presence.ts),
 *  and this HTTP-base derivation — so the badge, the edits, and the entitlement probe can never
 *  target different hubs. `INPLAN_PLUGIN_URL` wins, then legacy `INPLAN_COLLAB_URL`, then the default. */
export const resolveHubUrl = (): string => process.env.INPLAN_PLUGIN_URL || process.env.INPLAN_COLLAB_URL || DEFAULT_HUB_URL;
/** Plugin server HTTP base (ws→http), shared with the desktop app's entitlement check. */
const PLUGIN_HTTP = resolveHubUrl().replace(/^ws/, "http");
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
  resolve: typeof resolvePluginOutcome;
  importCli: (path: string) => Promise<CliEntry>;
}
const defaultDeps: PluginGateDeps = {
  resolve: resolvePluginOutcome,
  importCli: (p) => import(pathToFileURL(p).href) as Promise<CliEntry>,
};

export interface LoadPluginGateOptions {
  /** The user's token (from `authedSession`), or null when logged out (⇒ offline cache only). */
  token: string | null;
  apiBase?: string;
  cacheDir?: string;
  publicKey?: string;
}

/** A gate load's outcome: the gate, or why there isn't one — so a caller that must explain itself
 *  to a human can tell "your plan doesn't include this" from "we couldn't reach the server". */
export type PluginGateOutcome = { gate: PluginGate; reason: null } | { gate: null; reason: PluginAbsenceReason };

/**
 * Load the entitlement-gated, signature-verified plugin gate for `session`, or the reason there
 * isn't one. Fail-soft: any verify / fetch / import failure yields `unavailable`, and only an
 * explicit server denial yields `unentitled`. The plugin owns reachability — its read/apply time
 * out, and the caller falls back to the file.
 */
export async function loadPluginGateOutcome(session: string, options: LoadPluginGateOptions, deps: PluginGateDeps = defaultDeps): Promise<PluginGateOutcome> {
  try {
    const { plugin, reason } = await deps.resolve({
      apiBase: options.apiBase ?? PLUGIN_HTTP,
      token: options.token,
      cacheDir: options.cacheDir ?? defaultCacheDir(),
      // Forward whenever DEFINED, not whenever truthy: an explicit `""` means "nothing can be
      // verified" and must reach the resolver, which then refuses without a network call. Dropping
      // it would silently substitute the baked-in key and verify against something the caller
      // deliberately disabled.
      ...(options.publicKey !== undefined ? { publicKey: options.publicKey } : {}),
    });
    if (!plugin) return { gate: null, reason };
    const cliName = plugin.entries.cli;
    const cliPath = cliName ? plugin.files[cliName] : undefined;
    // Entitled + verified, but the bundle ships no CLI entry: not a plan problem, so `unavailable`.
    if (!cliPath) return { gate: null, reason: "unavailable" };
    const cli = await deps.importCli(cliPath);
    return { gate: cli.gate(session), reason: null };
  } catch {
    return { gate: null, reason: "unavailable" }; // any failure ⇒ file-backed
  }
}

/**
 * {@link loadPluginGateOutcome} for callers that only need "gate or not" (the local-file wait path,
 * which silently runs file-backed without the plugin).
 */
export async function loadPluginGate(session: string, options: LoadPluginGateOptions, deps: PluginGateDeps = defaultDeps): Promise<PluginGate | null> {
  try {
    return (await loadPluginGateOutcome(session, options, deps)).gate;
  } catch {
    return null; // any failure ⇒ file-backed
  }
}
