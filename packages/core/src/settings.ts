// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Doc-level user settings that affect *agent behavior* (so the agent and the
// editor must agree on them). These are a **user preference**, not a property
// of any one plan, so they live globally in `~/.agent-planner/settings.json`,
// load on launch, and are materialized into every `wait` result — a long
// control log can never make the agent "forget" the current value.
//
// fs/os-backed: import from `@agent-planner/core/node`, never the browser root.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { LogEventType } from "./controlLog";
import { readLog } from "./controlLogFs";

/** Settings that influence how the agent acts (kept minimal and additive). */
export interface Settings {
  /** When true, the agent resolves a thread after incorporating it; when false,
   *  it replies that the thread can be resolved and leaves it for the human. */
  autoResolve: boolean;
}

export const DEFAULT_SETTINGS: Settings = { autoResolve: true };

/** `~/.agent-planner/settings.json` — the global, cross-session source of truth.
 *  `AGENT_PLANNER_HOME` overrides the base dir (used by tests; avoids touching $HOME). */
export function globalSettingsPath(): string {
  const base = process.env.AGENT_PLANNER_HOME || join(homedir(), ".agent-planner");
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
  const settings = readGlobalSettings();
  for (const e of readLog(logPath)) {
    if (e.type === LogEventType.SettingsChanged && e.payload && typeof e.payload === "object") {
      Object.assign(settings, e.payload as Partial<Settings>);
    }
  }
  return settings;
}
