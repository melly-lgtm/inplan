// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan install-skill` also configures each present agent's own (launch-independent) hooks
// to relay turn messages + tool activity to the editor: Claude Code + Codex via a hooks object,
// Pi via an auto-loaded extension. Idempotent, preserves existing config, never clobbers.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
const SKILL_DIR = join(dirname(CLI), "..", "skill"); // install-skill is a no-op unless a skill is bundled

let home: string;
let stubbedSkill = false;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-relay-install-"));
  // Make all three agent targets exist so the installer touches each.
  mkdirSync(join(home, ".claude"), { recursive: true });
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
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

function install() {
  return spawnSync(process.execPath, [CLI, "install-skill", "--quiet"], { env: { ...process.env, HOME: home }, encoding: "utf8" });
}
const claudeSettings = () => JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
const codexHooks = () => JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"));
const piExtension = () => readFileSync(join(home, ".pi", "agent", "extensions", "inplan-relay.ts"), "utf8");

/** Commands installed under an event in a Claude/Codex-style hooks object. */
function commandsFor(hooks: Record<string, { hooks?: { command?: string }[] }[]>, event: string): string[] {
  return (hooks[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command ?? ""));
}

describe("inplan install-skill — agent-console relay hooks", () => {
  it("installs Claude Code Stop + PostToolUse relay hooks", () => {
    install();
    const h = claudeSettings().hooks;
    expect(commandsFor(h, "Stop")).toContain("inplan relay --hook claude-stop");
    expect(commandsFor(h, "PostToolUse")).toContain("inplan relay --hook claude-tool");
  });

  it("installs Codex relay hooks into hooks.json (JSON, no TOML)", () => {
    install();
    const h = codexHooks().hooks;
    expect(commandsFor(h, "Stop")).toContain("inplan relay --hook codex-stop");
    expect(commandsFor(h, "PostToolUse")).toContain("inplan relay --hook codex-tool");
  });

  it("installs the Pi auto-loaded relay extension", () => {
    install();
    const ext = piExtension();
    expect(ext).toContain("inplan-relay (managed by");
    expect(ext).toContain('pi.on("agent_end"');
    expect(ext).toContain('pi.on("tool_execution_start"');
  });

  it("is idempotent — running twice doesn't duplicate hooks", () => {
    install();
    install();
    expect(commandsFor(claudeSettings().hooks, "Stop").filter((c) => c === "inplan relay --hook claude-stop")).toHaveLength(1);
    expect(commandsFor(codexHooks().hooks, "PostToolUse").filter((c) => c === "inplan relay --hook codex-tool")).toHaveLength(1);
  });

  it("preserves existing Claude settings + hooks (merge, not clobber)", () => {
    writeFileSync(
      join(home, ".claude", "settings.json"),
      JSON.stringify({ model: "opus", hooks: { Stop: [{ hooks: [{ type: "command", command: "echo existing" }] }] } }) + "\n",
    );
    install();
    const s = claudeSettings();
    expect(s.model).toBe("opus"); // untouched
    const stop = commandsFor(s.hooks, "Stop");
    expect(stop).toContain("echo existing"); // kept
    expect(stop).toContain("inplan relay --hook claude-stop"); // added
  });

  it("does not clobber a user's own Pi extension file", () => {
    const path = join(home, ".pi", "agent", "extensions", "inplan-relay.ts");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "// my own extension\nexport default () => {};\n");
    install();
    expect(readFileSync(path, "utf8")).toBe("// my own extension\nexport default () => {};\n");
  });
});
