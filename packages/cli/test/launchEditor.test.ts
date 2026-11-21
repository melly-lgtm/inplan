// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan launch-editor <file>` — the desktop app's Restart after a self-update. It starts an editor
// and returns at once, through the CLI on disk (so the NEW install resolves the NEW Electron).
// The app runs CLI commands with ELECTRON_RUN_AS_NODE=1; an editor inheriting it starts as plain
// Node and exits with no window, which is how Restart closed the editor and brought nothing back.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scrubAgentEnv } from "../src/cli";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js");
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-launch-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A throwaway "editor" that records the ELECTRON_RUN_AS_NODE it was started with, next to the doc. */
const FAKE_EDITOR = `${process.execPath} -e "require('fs').writeFileSync(process.argv[1] + '.env', String(process.env.ELECTRON_RUN_AS_NODE))"`;

function run(args: string[]) {
  const env = { ...scrubAgentEnv(process.env), INPLAN_HOME: home, INPLAN_SIDECAR_DIR: join(home, "sidecars"), INPLAN_APP_CMD: FAKE_EDITOR, CI: "1", ELECTRON_RUN_AS_NODE: "1" };
  return spawnSync(process.execPath, [CLI, ...args], { env, encoding: "utf8" });
}

async function waitFor(cond: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

describe("inplan launch-editor (the app's Restart)", () => {
  it("starts an editor on the file, returns at once with its pid, and records it as the editor", () => {
    const file = join(home, "plan.md");
    writeFileSync(file, "# Plan\n");
    const r = run(["launch-editor", file]);
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout.trim().split("\n").at(-1)!) as { status: string; pid: number };
    expect(out.status).toBe("launched");
    expect(out.pid).toBeGreaterThan(0);
    const key = readdirSync(join(home, "sidecars"))[0]!;
    expect(readFileSync(join(home, "sidecars", key, "log.jsonl"), "utf8")).toContain(`"pid":${out.pid}`);
  });

  it("never hands the editor ELECTRON_RUN_AS_NODE, even when the CLI itself runs with it", async () => {
    const file = join(home, "plan.md");
    writeFileSync(file, "# Plan\n");
    expect(run(["launch-editor", file]).status).toBe(0);
    expect(await waitFor(() => existsSync(`${file}.env`), 5000)).toBe(true);
    expect(readFileSync(`${file}.env`, "utf8")).toBe("undefined");
  });

  it("fails cleanly, starting nothing, for a file that doesn't exist", () => {
    const r = run(["launch-editor", join(home, "missing.md")]);
    expect(r.status).toBe(1);
    expect(JSON.parse(r.stdout.trim()).status).toBe("launch_failed");
    expect(existsSync(join(home, "sidecars"))).toBe(false);
  });
});
