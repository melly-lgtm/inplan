// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendLog,
  currentSettings,
  DEFAULT_SETTINGS,
  globalSettingsPath,
  LogEventType,
  readGlobalSettings,
  writeGlobalSettings,
} from "../src/node";

let home: string;
let dir: string;
let logPath: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "ap-home-"));
  dir = mkdtempSync(join(tmpdir(), "ap-doc-"));
  logPath = join(dir, "doc.log.jsonl");
  process.env.INPLAN_HOME = home;
});

afterEach(() => {
  delete process.env.INPLAN_HOME;
  rmSync(home, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
});

describe("global settings", () => {
  it("returns defaults when no file exists", () => {
    expect(readGlobalSettings()).toEqual(DEFAULT_SETTINGS);
    expect(DEFAULT_SETTINGS.autoResolve).toBe(false);
  });

  it("round-trips through the global file under INPLAN_HOME", () => {
    writeGlobalSettings({ autoResolve: false });
    expect(globalSettingsPath()).toBe(join(home, "settings.json"));
    expect(readGlobalSettings()).toEqual({ autoResolve: false });
    // human-readable on disk
    expect(readFileSync(globalSettingsPath(), "utf8")).toContain('"autoResolve": false');
  });

  it("merges partial files over defaults", () => {
    writeGlobalSettings({} as never);
    expect(readGlobalSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("falls back to defaults when the settings file is corrupt (invalid JSON)", () => {
    writeFileSync(globalSettingsPath(), "{ not valid json");
    expect(readGlobalSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it("currentSettings folds in-session settings_changed over the global base", () => {
    writeGlobalSettings({ autoResolve: true }); // global default for this user
    // mid-session the user turns it off, then on, then off again
    appendLog(logPath, { actor: "user", type: LogEventType.SettingsChanged, payload: { autoResolve: false } });
    appendLog(logPath, { actor: "user", type: LogEventType.SettingsChanged, payload: { autoResolve: true } });
    appendLog(logPath, { actor: "user", type: LogEventType.SettingsChanged, payload: { autoResolve: false } });
    expect(currentSettings(logPath).autoResolve).toBe(false); // last write wins
  });

  it("currentSettings uses the global value when the session log has no changes", () => {
    writeGlobalSettings({ autoResolve: false });
    expect(currentSettings(logPath)).toEqual({ autoResolve: false });
  });
});
