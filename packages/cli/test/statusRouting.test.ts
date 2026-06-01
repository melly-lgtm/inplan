// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The CLI follows a document's location status: a `cloud` status routes
// open/wait/signal to the Supabase backend, reconciling first if the on-disk
// copy diverged. These cases are offline — when the cloud path is reached with
// no stored session it stops at "not logged in", which is enough to prove the
// routing decision without a network round-trip.

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let home: string;
let file: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-route-"));
  file = join(home, "plan.md");
  writeFileSync(file, "# Plan\n\nbody\n");
  env = { ...process.env, INPLAN_HOME: home, INPLAN_SIDECAR_DIR: join(home, "sidecars") };
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("status-driven routing", () => {
  it("reports a fresh doc as local", () => {
    const r = run("status", file);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual({ location: "local" });
  });

  it("promote records a cloud pointer", () => {
    expect(run("promote", file, "--cloud-doc", "doc-9", "--locator", "acme/plans/q3/road.md").code).toBe(0);
    const status = JSON.parse(run("status", file).out);
    expect(status.location).toBe("cloud");
    expect(status.cloudDocId).toBe("doc-9");
    expect(status.cloudLocator).toEqual({ org: "acme", repo: "plans", path: "q3/road.md" });
  });

  it("promote requires a cloud doc id", () => {
    expect(run("promote", file).code).toBe(64);
  });

  it("an in-sync cloud doc routes to the cloud backend (stops at auth)", () => {
    run("promote", file, "--cloud-doc", "doc-9"); // lastSyncedHash = current body
    const r = run("wait", file); // unchanged file -> no reconcile -> cloud -> needs login
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not logged in/i);
  });

  it("a diverged cloud doc surfaces reconcile_required", () => {
    run("promote", file, "--cloud-doc", "doc-9");
    writeFileSync(file, "# Plan\n\nedited locally\n"); // diverge from lastSyncedHash
    const r = run("wait", file);
    expect(r.code).toBe(0);
    const out = JSON.parse(r.out);
    expect(out.status).toBe("reconcile_required");
    expect(out.cloudDocId).toBe("doc-9");
  });

  it("--use-cloud overrides a diverged file and routes to the cloud", () => {
    run("promote", file, "--cloud-doc", "doc-9");
    writeFileSync(file, "# Plan\n\nedited locally\n");
    const r = run("wait", file, "--use-cloud");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/not logged in/i);
  });

  it("--continue-locally flips a diverged cloud doc back to local", async () => {
    run("promote", file, "--cloud-doc", "doc-9");
    writeFileSync(file, "# Plan\n\nedited locally\n");

    // `wait --continue-locally` flips the status synchronously, then blocks in the
    // local wait loop — spawn it, give it a moment to flip, then kill and assert.
    const child = spawn(process.execPath, [CLI, "wait", file, "--continue-locally"], { env });
    await new Promise((res) => setTimeout(res, 1500));
    child.kill();

    expect(JSON.parse(run("status", file).out)).toMatchObject({ location: "local" });
  }, 15000);
});
