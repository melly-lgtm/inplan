// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Whether the first-run onboarding tour has already been shown — persisted at the
// USER level (`~/.inplan/state.json`), not in the renderer's localStorage. The
// localStorage flag is per-Electron-userData and can reset across launches/installs,
// which made the tour reappear every relaunch; a fixed ~/.inplan file is durable.
//
// fs/os-backed: import from `@inplan/core/node`, never the browser root.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** `~/.inplan/state.json` — small bag of cross-session UI state. `INPLAN_HOME` overrides (tests). */
export function uiStatePath(): string {
  const base = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(base, "state.json");
}

interface UiState {
  onboarded?: boolean;
}

function readUiState(): UiState {
  const p = uiStatePath();
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, "utf8")) as UiState;
  } catch {
    return {};
  }
}

/** True once the first-run tour has been completed or skipped. */
export function isOnboarded(): boolean {
  return readUiState().onboarded === true;
}

/** Record that the tour has been shown (completed or skipped), preserving other state. */
export function markOnboarded(): void {
  const path = uiStatePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ ...readUiState(), onboarded: true }, null, 2)}\n`);
}
