// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan comment <file> (--parent-id <id>|--doc) --text "..."` — a typed writer for a
// reply/answer or document-level comment, so `date` comes from the CLI's own real clock
// instead of the agent hand-writing the JSON block and guessing it. Smoke-tests the wiring
// (flag parsing, file write, exit codes); the construction logic itself is unit-tested in
// commentAdd.test.ts.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "@inplan/core";
import { docPaths, writeStatus } from "@inplan/core/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let home: string;
let file: string;
let env: NodeJS.ProcessEnv;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-comment-"));
  file = join(home, "plan.md");
  writeFileSync(file, 'Use [Postgres](#cmt-abc123).\n\n<!--inplan v1\n[{"id":"cmt-abc123","author":"a","date":"2020-01-01T00:00:00.000Z","resolved":false,"text":"Confirm the datastore?"}]\n-->\n');
  process.env.INPLAN_SIDECAR_DIR = join(home, "sidecars");
  env = { ...process.env, INPLAN_HOME: home };
});
afterEach(() => {
  delete process.env.INPLAN_SIDECAR_DIR;
  rmSync(home, { recursive: true, force: true });
});

function run(...args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
  return { code: r.status, out: r.stdout.trim(), err: r.stderr.trim() };
}

describe("inplan comment", () => {
  it("appends a reply with a real timestamp and the model-qualified author", () => {
    const before = Date.now();
    const r = run("comment", file, "--parent-id", "cmt-abc123", "--text", "Confirmed.", "--model", "Opus 4.8");
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out);
    expect(result.status).toBe("commented");
    expect(result.author).toBe("Opus 4.8 <claude@inplan.ai>");
    expect(new Date(result.date).getTime()).toBeGreaterThanOrEqual(before);

    const doc = parse(readFileSync(file, "utf8"));
    const reply = doc.comments.find((c) => c.id === result.id);
    expect(reply?.parentId).toBe("cmt-abc123");
    expect(reply?.text).toBe("Confirmed.");
  });

  it("appends a document-level comment with --doc", () => {
    const r = run("comment", file, "--doc", "--text", "New question.");
    expect(r.code).toBe(0);
    const result = JSON.parse(r.out);
    const doc = parse(readFileSync(file, "utf8"));
    const added = doc.comments.find((c) => c.id === result.id);
    expect(added?.anchor).toBe("doc");
    expect(added?.parentId).toBeUndefined();
  });

  it("sets may_resolve when --may-resolve is passed", () => {
    const r = run("comment", file, "--parent-id", "cmt-abc123", "--text", "done", "--may-resolve");
    const result = JSON.parse(r.out);
    const doc = parse(readFileSync(file, "utf8"));
    expect(doc.comments.find((c) => c.id === result.id)?.may_resolve).toBe(true);
  });

  it("rejects a missing --text", () => {
    const r = run("comment", file, "--parent-id", "cmt-abc123");
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/usage: inplan comment/);
  });

  it("rejects both --parent-id and --doc", () => {
    const r = run("comment", file, "--parent-id", "cmt-abc123", "--doc", "--text", "x");
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/mutually exclusive/);
  });

  it("rejects an unknown parent id", () => {
    const r = run("comment", file, "--parent-id", "cmt-zzzzzz", "--text", "x");
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/no such parent id/);
  });

  it("rejects malformed --question JSON", () => {
    const r = run("comment", file, "--doc", "--text", "x", "--question", "not json");
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/must be valid JSON/);
  });

  it("rejects a --question that's valid JSON but not shaped like a Question", () => {
    const r = run("comment", file, "--doc", "--text", "x", "--question", "{}");
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/must be shaped like/);
  });

  it("rejects a promoted cloud doc instead of silently falling through to wait", () => {
    // Promote the doc's status to "cloud" the same way `inplan promote` would, without needing a
    // real Supabase backend — routeFor only reads status.json.
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-123", originalPath: file });
    const r = run("comment", file, "--doc", "--text", "x");
    expect(r.code).toBe(64);
    expect(r.err).toMatch(/cloud docs aren't supported/);
  });

  it("errors cleanly on a nonexistent file", () => {
    const r = run("comment", join(home, "missing.plan.md"), "--doc", "--text", "x");
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/file not found/);
  });
});
