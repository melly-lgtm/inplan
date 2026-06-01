// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { checkForUpdate, compareVersions } from "../src/update";

describe("compareVersions", () => {
  it("orders numerically, not lexically", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
    expect(compareVersions("1.2.3", "1.2.4")).toBe(-1);
    expect(compareVersions("1.10.0", "1.9.9")).toBe(1); // 10 > 9, not "1" < "9"
    expect(compareVersions("2.0.0", "1.999.999")).toBe(1);
  });

  it("ignores prerelease suffixes and missing segments", () => {
    expect(compareVersions("1.2.0-beta.1", "1.2.0")).toBe(0);
    expect(compareVersions("1.2", "1.2.0")).toBe(0);
    expect(compareVersions("1.3", "1.2.9")).toBe(1);
  });
});

describe("checkForUpdate", () => {
  it("flags an update when the registry has a newer version", async () => {
    const r = await checkForUpdate({ pkg: "x", current: "0.1.0", fetchLatest: async () => "0.2.0" });
    expect(r).toEqual({ current: "0.1.0", latest: "0.2.0", updateAvailable: true });
  });

  it("does not flag when current is latest or ahead", async () => {
    expect((await checkForUpdate({ pkg: "x", current: "1.0.0", fetchLatest: async () => "1.0.0" })).updateAvailable).toBe(false);
    expect((await checkForUpdate({ pkg: "x", current: "1.1.0", fetchLatest: async () => "1.0.0" })).updateAvailable).toBe(false);
  });

  it("does not flag when the registry is unreachable", async () => {
    const r = await checkForUpdate({ pkg: "x", current: "1.0.0", fetchLatest: async () => null });
    expect(r.updateAvailable).toBe(false);
    expect(r.latest).toBeNull();
  });
});
