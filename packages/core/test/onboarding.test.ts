// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isOnboarded, markOnboarded, uiStatePath } from "../src/onboarding";

let home: string;
const prev = process.env.INPLAN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-onboard-"));
  process.env.INPLAN_HOME = home;
});
afterEach(() => {
  if (prev === undefined) delete process.env.INPLAN_HOME;
  else process.env.INPLAN_HOME = prev;
  rmSync(home, { recursive: true, force: true });
});

describe("onboarding state (INPLAN_HOME/state.json)", () => {
  it("uiStatePath honors INPLAN_HOME", () => {
    expect(uiStatePath()).toBe(join(home, "state.json"));
  });

  it("isOnboarded is false before, true after markOnboarded (and persists)", () => {
    expect(isOnboarded()).toBe(false); // no file yet
    markOnboarded();
    expect(existsSync(uiStatePath())).toBe(true);
    expect(isOnboarded()).toBe(true);
    expect(JSON.parse(readFileSync(uiStatePath(), "utf8"))).toEqual({ onboarded: true });
  });

  it("markOnboarded preserves other state keys", () => {
    writeFileSync(uiStatePath(), JSON.stringify({ other: 42 }));
    markOnboarded();
    expect(JSON.parse(readFileSync(uiStatePath(), "utf8"))).toEqual({ other: 42, onboarded: true });
  });

  it("a malformed state file reads as not-onboarded (fail-soft)", () => {
    writeFileSync(uiStatePath(), "{ not json");
    expect(isOnboarded()).toBe(false);
  });
});
