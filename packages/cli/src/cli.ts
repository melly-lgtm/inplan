#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { appendLog, LogEventType, readLog } from "@agent-planner/core/node";
import { runningEditorPid } from "./editorProcess";
import { evaluateAgentEdit } from "./gate";
import { docPaths, type DocPaths } from "./paths";
import { wakePredicate, waitForActions } from "./wait";

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

/** Latest cadence from the control log (Turn unless a mode_changed says otherwise). */
function currentCadence(logPath: string): "turn" | "instant" {
  const entries = readLog(logPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.ModeChanged) {
      const c = (entries[i]!.payload as { cadence?: string } | undefined)?.cadence;
      if (c === "instant" || c === "turn") return c;
    }
  }
  return "turn";
}

/** The highest seq in the control log (0 if empty). */
function maxSeq(logPath: string): number {
  const entries = readLog(logPath);
  return entries.length ? entries[entries.length - 1]!.seq : 0;
}

/** The persisted wait cursor (what the agent has already consumed), or null. */
function readCursor(p: DocPaths): number | null {
  if (!existsSync(p.cursorPath)) return null;
  const n = Number(readFileSync(p.cursorPath, "utf8").trim());
  return Number.isFinite(n) ? n : null;
}

function writeCursor(p: DocPaths, seq: number): void {
  writeFileSync(p.cursorPath, String(seq));
}

/**
 * Evaluate the agent's edit (gate), accept it as canonical, then block for user
 * actions. The cursor is self-managed: an explicit override, else the persisted
 * cursor, else "start from now" (current max). It is persisted on return so the
 * agent never hand-manages it and turns can't be skipped.
 */
async function waitCycle(file: string, explicitCursor: number | null, confirmed: Set<string>): Promise<void> {
  const p = docPaths(file);
  mkdirSync(p.controlDir, { recursive: true });

  const cursor = explicitCursor ?? readCursor(p) ?? maxSeq(p.logPath);

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

  // Signal the agent has (re)engaged this round so the editor can clear its
  // "Agent is thinking…" indicator even when the agent made no body change.
  appendLog(p.logPath, { actor: "agent", type: LogEventType.AgentRevised });

  // Mode-aware wake: Turn mode wakes only on turn-end / session-close; Instant on any user action.
  const cadence = currentCadence(p.logPath);
  const isActionable = wakePredicate(cadence);
  const result = await waitForActions({ logPath: p.logPath, cursor, debounceMs, pollMs, isActionable });
  writeCursor(p, result.cursor); // advance the persisted cursor so the next call continues here

  // The editor logs WHY it closed (completed / window_closed); a crash logs nothing.
  const closeEntry = result.entries.find((e) => e.type === LogEventType.SessionClosed);
  // Control message per situation so the agent knows how to behave:
  //   your_turn     — Turn mode: human finished their turn and is LOCKED; revise, then
  //                   call wait to hand control back.
  //   activity      — Instant mode: human is editing LIVE and is NOT blocked.
  //   closed        — the editor closed cleanly; `reason` says completed vs window_closed.
  //   editor_closed — the editor vanished with no close log (crashed/killed).
  let status: string;
  let reason: string | undefined;
  if (closeEntry) {
    status = "closed";
    reason = (closeEntry.payload as { reason?: string } | undefined)?.reason ?? "closed";
  } else if (result.editorGone) {
    status = "editor_closed";
    reason = "crashed_or_killed";
  } else {
    status = cadence === "turn" ? "your_turn" : "activity";
  }
  output({
    status,
    mode: cadence,
    humanLocked: status === "your_turn",
    ...(reason ? { reason } : {}),
    cursor: result.cursor,
    closed: !!closeEntry || !!result.editorGone,
    editorGone: !!result.editorGone,
    entries: result.entries,
  });
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
  const cursorFlag = getFlag(rest, "cursor");
  const explicitCursor = cursorFlag !== undefined ? Number(cursorFlag) : null; // optional override; wait self-manages otherwise
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
    const existing = runningEditorPid(p.logPath);
    if (existing !== null) {
      process.stderr.write(`[agent-planner] an editor is already open for this document (pid ${existing}); attaching without launching another window\n`);
    } else {
      const pid = spawnApp(file);
      if (pid !== null) {
        appendLog(p.logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid } });
      }
    }
  }

  await waitCycle(file, explicitCursor, confirmed);
}

main().catch((err) => {
  process.stderr.write(`agent-planner: ${(err as Error).message}\n`);
  process.exit(1);
});
