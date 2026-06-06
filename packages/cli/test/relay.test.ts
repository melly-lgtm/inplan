// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan relay` is the agent-console hook target: an agent's config-fired hook invokes it,
// and it resolves the plan doc being worked on in the CWD (the most-recently-active sidecar
// under it) and relays the note onto that doc's control channel (→ the editor's agent-message
// history). These tests drive the built CLI as a subprocess, like installSkill.test.ts.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { docPaths } from "@inplan/core/node";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");

let home: string;
let repo: string;
let doc: string;
let savedHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-relay-home-"));
  repo = mkdtempSync(join(tmpdir(), "inplan-relay-repo-"));
  doc = join(repo, "plan.plan.md");
  writeFileSync(doc, "# Plan\n\n<!--inplan v1\n[]\n-->\n");
  // docPaths() resolves the sidecar root from INPLAN_HOME — set it in THIS process too so the
  // test and the subprocess agree on where the doc's sidecar lives.
  savedHome = process.env.INPLAN_HOME;
  process.env.INPLAN_HOME = home;
});
afterEach(() => {
  if (savedHome === undefined) delete process.env.INPLAN_HOME;
  else process.env.INPLAN_HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
  rmSync(repo, { recursive: true, force: true });
});

/** Seed the doc's sidecar status so the relay can discover it as the active doc under `repo`. */
function seedDoc() {
  const p = docPaths(doc);
  mkdirSync(p.controlDir, { recursive: true });
  writeFileSync(p.statusPath, JSON.stringify({ location: "local", originalPath: doc }) + "\n");
}

function relay(args: string[], opts: { stdin?: string; cwd?: string } = {}) {
  return spawnSync(process.execPath, [CLI, "relay", ...args], {
    input: opts.stdin ?? "",
    cwd: opts.cwd ?? repo,
    env: { ...process.env, INPLAN_HOME: home, HOME: home },
    encoding: "utf8",
  });
}

const messages = () => {
  const log = docPaths(doc).logPath;
  if (!existsSync(log)) return [] as { type: string; payload?: { text?: string } }[];
  return readFileSync(log, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as { type: string; payload?: { text?: string } })
    .filter((e) => e.type === "agent_message");
};

describe("inplan relay — agent-console hook target", () => {
  it("claude-stop relays the turn's last assistant message to the active doc", () => {
    seedDoc();
    const r = relay(["--hook", "claude-stop"], { stdin: JSON.stringify({ last_assistant_message: "Adopted Postgres." }) });
    expect(r.status).toBe(0);
    expect(messages().map((m) => m.payload?.text)).toContain("Adopted Postgres.");
  });

  it("claude-tool relays a terse activity line", () => {
    seedDoc();
    relay(["--hook", "claude-tool"], { stdin: JSON.stringify({ tool_name: "Bash" }) });
    expect(messages().map((m) => m.payload?.text)).toContain("▸ Bash");
  });

  it("codex-notify reads the payload from argv (not stdin)", () => {
    seedDoc();
    const payload = JSON.stringify({ type: "agent-turn-complete", "last-assistant-message": "Renamed and verified." });
    relay(["--hook", "codex-notify", payload]);
    expect(messages().map((m) => m.payload?.text)).toContain("Renamed and verified.");
  });

  it("--text relays a direct message; --activity prefixes it", () => {
    seedDoc();
    relay(["--text", "hello"]);
    relay(["--activity", "--text", "grep"]);
    const texts = messages().map((m) => m.payload?.text);
    expect(texts).toContain("hello");
    expect(texts).toContain("▸ grep");
  });

  it("no-ops (no_active_doc) when no inplan doc is open under the CWD", () => {
    seedDoc(); // the only doc lives under `repo`, not under `other`
    const other = mkdtempSync(join(tmpdir(), "inplan-relay-other-"));
    try {
      const r = relay(["--hook", "claude-stop"], { stdin: JSON.stringify({ last_assistant_message: "x" }), cwd: other });
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("no_active_doc");
      expect(messages()).toHaveLength(0); // nothing relayed
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("no-ops (no_text) on an empty payload — never errors the agent's turn", () => {
    seedDoc();
    const r = relay(["--hook", "claude-stop"], { stdin: "{}" });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("no_text");
    expect(messages()).toHaveLength(0);
  });
});
