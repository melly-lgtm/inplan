// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { profilePath, readLocalProfile, resolveIdentity, setManualProfile, writeLocalProfile } from "../src/cliProfile";

let home: string;
const prev = process.env.INPLAN_HOME;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-prof-"));
  process.env.INPLAN_HOME = home;
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (prev === undefined) delete process.env.INPLAN_HOME;
  else process.env.INPLAN_HOME = prev;
});

describe("local profile store", () => {
  it("round-trips a profile through write/read", () => {
    writeLocalProfile({ name: "Diane Jung", email: "diane@example.com", source: "git" });
    expect(readLocalProfile()).toEqual({ name: "Diane Jung", email: "diane@example.com", source: "git" });
    expect(profilePath()).toBe(join(home, "profile.json"));
  });

  it("setManualProfile writes a manual-sourced profile", () => {
    expect(setManualProfile("Diane Jung", "diane@example.com")).toEqual({ name: "Diane Jung", email: "diane@example.com", source: "manual" });
    expect(readLocalProfile()?.source).toBe("manual");
  });

  it("setManualProfile tolerates a missing email", () => {
    expect(setManualProfile("Just A Name")).toEqual({ name: "Just A Name", source: "manual" });
  });

  it("reads null for a nameless or corrupt file", () => {
    writeFileSync(join(home, "profile.json"), JSON.stringify({ email: "x@y.z" }));
    expect(readLocalProfile()).toBeNull();
    writeFileSync(join(home, "profile.json"), "{ not json");
    expect(readLocalProfile()).toBeNull();
  });

  it("coerces an unknown source to manual", () => {
    writeFileSync(join(home, "profile.json"), JSON.stringify({ name: "X", source: "bogus" }));
    expect(readLocalProfile()?.source).toBe("manual");
  });
});

describe("resolveIdentity", () => {
  it("returns the stored profile without touching cloud/git", async () => {
    writeLocalProfile({ name: "Stored Name", email: "s@e.co", source: "manual" });
    expect(await resolveIdentity("/anywhere/doc.plan.md")).toEqual({ name: "Stored Name", email: "s@e.co", source: "manual" });
  });

  it("returns null when nothing resolves (no store, not signed in, non-git dir)", async () => {
    const nongit = mkdtempSync(join(tmpdir(), "inplan-nogit-"));
    expect(await resolveIdentity(join(nongit, "doc.plan.md"))).toBeNull();
    rmSync(nongit, { recursive: true, force: true });
  });
});
