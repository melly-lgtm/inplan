#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendLog, LogEventType } from "@agent-planner/core";
import { evaluateAgentEdit } from "./gate";
import { docPaths } from "./paths";
import { waitForActions } from "./wait";

const VERSION = "0.0.0";

function output(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function getFlag(args: string[], name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1]!.startsWith("--")) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

const debounceMs = Number(process.env.AGENT_PLANNER_DEBOUNCE_MS ?? 3000);
const pollMs = Number(process.env.AGENT_PLANNER_POLL_MS ?? 200);

function spawnApp(file: string): number | null {
  const cmd = process.env.AGENT_PLANNER_APP_CMD;
  if (!cmd) {
    process.stderr.write("[agent-planner] no editor configured (set AGENT_PLANNER_APP_CMD); running headless\n");
    return null;
  }
  const child = spawn(cmd, [file], { detached: true, stdio: "ignore", shell: true });
  child.unref();
  return child.pid ?? null;
}

/** Evaluate the agent's edit (gate), accept it as canonical, then block for user actions. */
async function waitCycle(file: string, cursor: number, confirmed: Set<string>): Promise<void> {
  const p = docPaths(file);
  mkdirSync(p.controlDir, { recursive: true });

  const current = readFileSync(file, "utf8");
  let canonicalText: string;
  if (existsSync(p.canonicalPath)) {
    canonicalText = readFileSync(p.canonicalPath, "utf8");
  } else {
    canonicalText = current;
    writeFileSync(p.canonicalPath, current);
  }

  const ev = evaluateAgentEdit(canonicalText, current, confirmed);
  if (ev.unconfirmed.length > 0) {
    output({
      status: "confirm_required",
      message: "Edit removes anchored comment(s). Re-run wait with --confirmed-comment-deletion=<ids> to proceed.",
      lost: ev.unconfirmed.map((c) => ({ id: c.id, text: c.text, author: c.author })),
    });
    process.exit(3);
  }
  if (!ev.integrityOk) {
    output({ status: "integrity_error", errors: ev.integrityErrors });
    process.exit(2);
  }
  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects from the document and canonical base.
    writeFileSync(file, ev.acceptedText);
    writeFileSync(p.canonicalPath, ev.acceptedText);
    appendLog(p.logPath, { actor: "agent", type: LogEventType.DocumentEdited, payload: { removed: ev.removedIds } });
  } else if (ev.changed) {
    writeFileSync(p.canonicalPath, current);
    appendLog(p.logPath, { actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: current.length } });
  }

  const result = await waitForActions({ logPath: p.logPath, cursor, debounceMs, pollMs });
  const closed = result.entries.some((e) => e.type === LogEventType.SessionClosed);
  output({ status: closed ? "closed" : "actions", cursor: result.cursor, closed, entries: result.entries });
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const file = argv[1];
  const rest = argv.slice(2);
  const cursor = Number(getFlag(rest, "cursor") ?? 0);
  const confirmed = new Set(
    (getFlag(rest, "confirmed-comment-deletion") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!cmd || !["open", "wait", "signal"].includes(cmd)) {
    process.stderr.write("usage: agent-planner <open|wait|signal> <file> [--cursor N] [--confirmed-comment-deletion=a,b] [--done]\n");
    process.exit(64);
  }
  if (!file) {
    process.stderr.write(`agent-planner ${cmd}: missing <file>\n`);
    process.exit(64);
  }

  if (cmd === "signal") {
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    if (hasFlag(rest, "done")) {
      appendLog(p.logPath, { actor: "agent", type: LogEventType.AgentDoneSuggested });
    }
    output({ status: "signaled" });
    return;
  }

  if (!existsSync(file)) {
    process.stderr.write(`agent-planner ${cmd}: file not found: ${file}\n`);
    process.exit(1);
  }

  if (cmd === "open") {
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    const pid = spawnApp(file);
    if (pid !== null) {
      appendLog(p.logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid } });
    }
  }

  await waitCycle(file, cursor, confirmed);
}

main().catch((err) => {
  process.stderr.write(`agent-planner: ${(err as Error).message}\n`);
  process.exit(1);
});
