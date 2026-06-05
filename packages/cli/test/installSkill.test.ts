// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan install-skill` grants Claude Code scoped auto-approval for the inplan workflow
// (the human reviews every change in the app, so per-edit prompts are pure friction):
// it merges a narrow permissions.allow + additionalDirectories into ~/.claude/settings.json,
// preserving everything else, de-duplicating, and never clobbering an unparseable file.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
// install-skill is a no-op ("unavailable") unless the bundled skill resolves next to dist/.
const SKILL_DIR = join(dirname(CLI), "..", "skill");

let home: string;
let stubbedSkill = false;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-skill-"));
  mkdirSync(join(home, ".claude"), { recursive: true }); // make the "Claude Code" target exist
  if (!existsSync(SKILL_DIR)) {
    mkdirSync(SKILL_DIR, { recursive: true });
    writeFileSync(join(SKILL_DIR, "SKILL.md"), "# inplan (test stub)\n");
    stubbedSkill = true;
  }
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
  if (stubbedSkill) {
    rmSync(SKILL_DIR, { recursive: true, force: true });
    stubbedSkill = false;
  }
});

function install(extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, "install-skill", "--quiet"], { env: { ...process.env, HOME: home, ...extraEnv }, encoding: "utf8" });
}
const readSettings = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));

describe("inplan install-skill — Claude Code auto-approval", () => {
  it("merges the scoped allow rules + sidecar dir into ~/.claude/settings.json", () => {
    install();
    const s = readSettings();
    expect(s.permissions.allow).toEqual(expect.arrayContaining(["Bash(inplan *)", "Edit(**/*.plan.md)", "Write(**/*.plan.md)", "Read(~/.inplan/**)", "Edit(~/.inplan/**)", "Write(~/.inplan/**)"]));
    expect(s.permissions.additionalDirectories).toContain("~/.inplan/");
  });

  it("is idempotent — running twice doesn't duplicate rules", () => {
    install();
    install();
    const s = readSettings();
    expect(s.permissions.allow.filter((r: string) => r === "Bash(inplan *)")).toHaveLength(1);
    expect(s.permissions.additionalDirectories.filter((d: string) => d === "~/.inplan/")).toHaveLength(1);
  });

  it("preserves existing settings + other allow rules", () => {
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "opus", permissions: { allow: ["Bash(npm *)"] } }) + "\n");
    install();
    const s = readSettings();
    expect(s.model).toBe("opus"); // untouched
    expect(s.permissions.allow).toContain("Bash(npm *)"); // kept
    expect(s.permissions.allow).toContain("Bash(inplan *)"); // added
  });

  it("does nothing when opted out via INPLAN_NO_SKILL_INSTALL", () => {
    install({ INPLAN_NO_SKILL_INSTALL: "1" });
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});
