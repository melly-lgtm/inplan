// SPDX-License-Identifier: AGPL-3.0-or-later

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_STATUS, hashBody, readStatus, writeStatus } from "../src/node";

let dir: string;
let statusPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplan-status-"));
  statusPath = join(dir, "status.json");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("doc status", () => {
  it("defaults to local when no status file exists", () => {
    expect(readStatus(statusPath)).toEqual(DEFAULT_STATUS);
    expect(DEFAULT_STATUS.location).toBe("local");
  });

  it("round-trips a cloud status", () => {
    const status = {
      location: "cloud" as const,
      cloudDocId: "doc-123",
      cloudLocator: { org: "acme", repo: "plans", path: "q3/roadmap.md" },
      originalPath: "/home/u/roadmap.md",
      lastSyncedHash: hashBody("# Roadmap\n"),
    };
    writeStatus(statusPath, status);
    expect(readStatus(statusPath)).toEqual(status);
  });

  it("creates the sidecar dir on write", () => {
    const nested = join(dir, "deep", "nested", "status.json");
    writeStatus(nested, { location: "local" });
    expect(readStatus(nested)).toEqual({ location: "local" });
  });

  it("treats corrupt JSON as the local default", () => {
    writeFileSync(statusPath, "{ not json");
    expect(readStatus(statusPath)).toEqual(DEFAULT_STATUS);
  });

  it("treats an unknown location as the local default", () => {
    writeFileSync(statusPath, JSON.stringify({ location: "moon" }));
    expect(readStatus(statusPath)).toEqual(DEFAULT_STATUS);
  });

  it("treats a cloud status with no doc id as local (meaningless pointer)", () => {
    writeFileSync(statusPath, JSON.stringify({ location: "cloud" }));
    expect(readStatus(statusPath)).toEqual(DEFAULT_STATUS);
  });

  it("hashBody is stable and content-sensitive", () => {
    expect(hashBody("hello")).toBe(hashBody("hello"));
    expect(hashBody("hello")).not.toBe(hashBody("hello!"));
  });
});
