// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers the network/spawn paths of update.ts: latestVersion (registry fetch) and
// selfUpdate (npm spawn), both stubbed — no network, no real `npm install`.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.fn();
vi.mock("node:child_process", () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { latestVersion, selfUpdate } from "../src/update";

afterEach(() => vi.restoreAllMocks());

describe("latestVersion", () => {
  it("returns the published version on a 2xx", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ version: "1.4.2" }) })));
    expect(await latestVersion("agent-planner")).toBe("1.4.2");
  });
  it("encodes a scoped name in the registry URL", async () => {
    const f = vi.fn(async () => ({ ok: true, json: async () => ({ version: "2.0.0" }) }));
    vi.stubGlobal("fetch", f);
    await latestVersion("@scope/pkg");
    expect(f).toHaveBeenCalledWith(expect.stringContaining("@scope%2Fpkg/latest"), expect.anything());
  });
  it("returns null on a non-ok response, a missing version, or a thrown fetch", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await latestVersion("p")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
    expect(await latestVersion("p")).toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    expect(await latestVersion("p")).toBeNull();
  });
});

/** A fake ChildProcess that lets the test drive stdout/stderr/close|error. */
function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  return child;
}

describe("selfUpdate", () => {
  it("resolves ok on exit 0, collecting stdout/stderr", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = selfUpdate("agent-planner");
    child.stdout.emit("data", "added 1 package");
    child.stderr.emit("data", "");
    child.emit("close", 0);
    await expect(p).resolves.toEqual({ ok: true, output: "added 1 package" });
    expect(spawnMock).toHaveBeenCalledWith("npm", ["install", "-g", "agent-planner@latest"], expect.anything());
  });
  it("resolves not-ok on a non-zero exit", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = selfUpdate("p");
    child.stderr.emit("data", "EACCES");
    child.emit("close", 1);
    await expect(p).resolves.toEqual({ ok: false, output: "EACCES" });
  });
  it("resolves not-ok when the process errors", async () => {
    const child = fakeChild();
    spawnMock.mockReturnValueOnce(child);
    const p = selfUpdate("p");
    child.emit("error", new Error("npm not found"));
    await expect(p).resolves.toEqual({ ok: false, output: "npm not found" });
  });
});
