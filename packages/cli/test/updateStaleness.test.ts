// SPDX-License-Identifier: AGPL-3.0-or-later
//
// An out-of-date CLI against a newer cloud is the failure mode with no symptom: it attaches, prints
// a normal turn status, and silently lacks the code path the document needs. These pin the warning
// that makes it visible — and, just as importantly, pin that it stays QUIET when it has nothing
// certain to say (registry down) and cheap when called every turn (TTL cache).

import { describe, expect, it, vi } from "vitest";
import { STALENESS_TTL_MS, warnIfOutdated } from "../src/update";

/** Capture stderr for one call; the warning must never touch stdout (the agent's JSON channel). */
async function capture(fn: () => Promise<string | null>): Promise<{ result: string | null; err: string; out: string }> {
  let err = "";
  let out = "";
  const se = vi.spyOn(process.stderr, "write").mockImplementation((c: unknown) => ((err += String(c)), true));
  const so = vi.spyOn(process.stdout, "write").mockImplementation((c: unknown) => ((out += String(c)), true));
  try {
    return { result: await fn(), err, out };
  } finally {
    se.mockRestore();
    so.mockRestore();
  }
}

/** An in-memory staleness cache. */
function memCache(initial: string | null = null) {
  let v = initial;
  return { readCache: () => v, writeCache: (s: string) => void (v = s) };
}

describe("warnIfOutdated", () => {
  it("warns on stderr (never stdout) when the registry has a newer version", async () => {
    const { result, err, out } = await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest: async () => "0.1.26", now: () => 1000, ...memCache() }));
    expect(result).toContain("0.1.25");
    expect(result).toContain("0.1.26");
    expect(err).toContain("npm i -g inplan@latest");
    expect(out).toBe(""); // stdout carries the agent's JSON — a human warning must not corrupt it
  });

  it("stays silent when current is the latest", async () => {
    const { result, err } = await capture(() => warnIfOutdated("inplan", "0.1.26", { fetchLatest: async () => "0.1.26", now: () => 1000, ...memCache() }));
    expect(result).toBeNull();
    expect(err).toBe("");
  });

  it("stays silent when ahead of the registry (a local dev build)", async () => {
    const { result } = await capture(() => warnIfOutdated("inplan", "0.2.0", { fetchLatest: async () => "0.1.26", now: () => 1000, ...memCache() }));
    expect(result).toBeNull();
  });

  it("an unreachable registry says nothing rather than crying wolf", async () => {
    const { result, err } = await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest: async () => null, now: () => 1000, ...memCache() }));
    expect(result).toBeNull();
    expect(err).toBe("");
  });

  it("caches the verdict so a per-turn call costs one registry hit per TTL", async () => {
    const cache = memCache();
    const fetchLatest = vi.fn(async () => "0.1.26");
    await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, now: () => 1000, ...cache }));
    const second = await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, now: () => 1000 + STALENESS_TTL_MS - 1, ...cache }));
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(second.result).toContain("0.1.26"); // still warns — served from cache
  });

  it("re-checks once the cache goes stale", async () => {
    const cache = memCache();
    const fetchLatest = vi.fn(async () => "0.1.26");
    await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, now: () => 1000, ...cache }));
    await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, now: () => 1000 + STALENESS_TTL_MS, ...cache }));
    expect(fetchLatest).toHaveBeenCalledTimes(2);
  });

  it("a cache stamped in the future is re-checked, not trusted (clock rewind)", async () => {
    const fetchLatest = vi.fn(async () => "0.1.26");
    const cache = memCache(JSON.stringify({ at: 50_000, latest: "0.1.25", pkg: "inplan" }));
    const { result } = await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, now: () => 1000, ...cache }));
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(result).toContain("0.1.26");
  });

  // A partial record passes the freshness check but carries no verdict, so serving it would suppress
  // the refresh for the whole TTL — silence a user cannot tell from "you're up to date".
  it("treats an incomplete cache record as a miss and re-checks", async () => {
    for (const bad of [{ at: 1000, pkg: "inplan" }, { at: 1000, latest: 42, pkg: "inplan" }, { at: 1000, latest: null, pkg: "inplan" }, { latest: "0.1.26", pkg: "inplan" }]) {
      const fetchLatest = vi.fn(async () => "0.1.26");
      const cache = memCache(JSON.stringify(bad));
      const { result } = await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, now: () => 1500, ...cache }));
      expect(fetchLatest, JSON.stringify(bad)).toHaveBeenCalledTimes(1);
      expect(result).toContain("0.1.26");
    }
  });

  // `INPLAN_PKG` lets a fork or scoped build share this cache file. Without the package in the
  // record, a fork would compare its own version against the OFFICIAL package's latest — warning
  // falsely, or staying silent about a real fork update, for the whole TTL.
  it("treats a cache written for a different package as a miss", async () => {
    const fetchLatest = vi.fn(async () => "2.0.0");
    const cache = memCache(JSON.stringify({ at: 1000, latest: "0.1.26", pkg: "inplan" }));
    const { result } = await capture(() => warnIfOutdated("@acme/inplan-fork", "1.0.0", { fetchLatest, now: () => 1500, ...cache }));
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(result).toContain("2.0.0");
  });

  it("records the package it checked, so the next run can tell whose verdict it holds", async () => {
    const cache = memCache();
    await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest: async () => "0.1.26", now: () => 1000, ...cache }));
    expect(JSON.parse(cache.readCache()!)).toEqual({ at: 1000, latest: "0.1.26", pkg: "inplan" });
  });

  it("a corrupt cache is ignored, not fatal", async () => {
    const fetchLatest = vi.fn(async () => "0.1.26");
    const cache = memCache("{not json");
    const { result } = await capture(() => warnIfOutdated("inplan", "0.1.25", { fetchLatest, ...cache }));
    expect(fetchLatest).toHaveBeenCalledTimes(1);
    expect(result).toContain("0.1.26");
  });

  it("a cache that can't be written is an optimisation loss, not a failure", async () => {
    const { result } = await capture(() =>
      warnIfOutdated("inplan", "0.1.25", {
        fetchLatest: async () => "0.1.26",
        now: () => 1000,
        readCache: () => null,
        writeCache: () => {
          throw new Error("read-only fs");
        },
      }),
    );
    expect(result).toContain("0.1.26");
  });
});
