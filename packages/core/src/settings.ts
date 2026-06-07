// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Doc-level user settings that affect *agent behavior* (so the agent and the
// editor must agree on them). These are a **user preference**, not a property
// of any one plan, so they live globally in `~/.inplan/settings.json`,
// load on launch, and are materialized into every `wait` result — a long
// control log can never make the agent "forget" the current value.
//
// fs/os-backed: import from `@inplan/core/node`, never the browser root.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type LogEntry, LogEventType } from "./controlLog";
import { readLog } from "./controlLogFs";

/** Which mode the agent operates in: drafting/refining the plan, or building it. */
export type AgentMode = "planning" | "implementation";

/** Settings that influence how the agent acts (kept minimal and additive). */
export interface Settings {
  /** When true, the agent resolves a thread after incorporating it; when false,
   *  it replies that the thread can be resolved and leaves it for the human. */
  autoResolve: boolean;
  /** "planning" (draft/refine the doc — the normal loop) or "implementation" (the
   *  human switched the agent to build mode; it implements what the doc specifies).
   *  Optional for back-compat; reads default to "planning" via DEFAULT_SETTINGS. */
  agentMode?: AgentMode;
  /** Opt-in: send anonymous usage events (Plausible). Absent/false ⇒ nothing is sent.
   *  Off by default — not added to DEFAULT_SETTINGS, so a missing value reads as off. */
  telemetry?: boolean;
  /** How the agent's body edits are accepted: "review" parks them as a proposal for the human to
   *  accept/reject; "auto" applies them directly. A **global** preference (read from settings.json
   *  by both the app and the CLI gate), default "review". */
  acceptance?: "auto" | "review";
}

// Agent-behavior defaults for first-time users: the agent parks its edits for **review** (the
// human approves each change), leaves threads for the human to resolve, and starts in planning
// mode. The first-run onboarding explains how to change these.
export const DEFAULT_SETTINGS: Settings = { autoResolve: false, agentMode: "planning", acceptance: "review" };

/** `~/.inplan/settings.json` — the global, cross-session source of truth.
 *  `INPLAN_HOME` overrides the base dir (used by tests; avoids touching $HOME). */
export function globalSettingsPath(): string {
  const base = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(base, "settings.json");
}

/** Read the global settings, merged over defaults. Missing/corrupt → defaults. */
export function readGlobalSettings(): Settings {
  const path = globalSettingsPath();
  if (!existsSync(path)) return { ...DEFAULT_SETTINGS };
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<Settings>;
    return { ...DEFAULT_SETTINGS, ...raw };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/** Persist the global settings (written on every toggle in the editor). */
export function writeGlobalSettings(settings: Settings): void {
  const path = globalSettingsPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`);
}

/**
 * The current settings the agent should act on: the global file as the base,
 * with any in-session `settings_changed` events from this document's control
 * log folded on top (the log is authoritative for changes made this session).
 */
export function currentSettings(logPath: string): Settings {
  return settingsFromEntries(readLog(logPath));
}

/**
 * Fold any `settings_changed` events over a base (the global file by default).
 * The storage-agnostic core of {@link currentSettings}: the desktop edition
 * passes its file-read log; the cloud edition passes the document's `events`
 * history, so both materialize identical settings without a local sidecar.
 */
export function settingsFromEntries(entries: LogEntry[], base: Settings = readGlobalSettings()): Settings {
  const settings = { ...base };
  for (const e of entries) {
    if (e.type === LogEventType.SettingsChanged && e.payload && typeof e.payload === "object") {
      Object.assign(settings, e.payload as Partial<Settings>);
    }
  }
  return settings;
}
