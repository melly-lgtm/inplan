#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { CONTROL_LOG_VERSION, currentSettings, FsControlChannel, FsDocumentStore, LogEventType, parse, readLog } from "@inplan/core/node";
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

const debounceMs = Number(process.env.INPLAN_DEBOUNCE_MS ?? 3000);
const pollMs = Number(process.env.INPLAN_POLL_MS ?? 200);

function spawnApp(file: string): number | null {
  const cmd = process.env.INPLAN_APP_CMD;
  if (!cmd) {
    process.stderr.write("[inplan] no editor configured (set INPLAN_APP_CMD); running headless\n");
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

/** Latest agent-change acceptance from the control log (Auto unless a mode_changed says Review). */
function currentAcceptance(logPath: string): "auto" | "review" {
  const entries = readLog(logPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.ModeChanged) {
      const a = (entries[i]!.payload as { acceptance?: string } | undefined)?.acceptance;
      if (a === "auto" || a === "review") return a;
    }
  }
  return "auto";
}

/** The highest seq in the control log (0 if empty). */
function maxSeq(logPath: string): number {
  const entries = readLog(logPath);
  return entries.length ? entries[entries.length - 1]!.seq : 0;
}

/** Record why a waiter exited (normal status / superseded / OS signal), for debugging
 *  the "waiter vanished" reports — a reaped process leaves a `signal:*` line here. */
function logWaitExit(p: DocPaths, reason: string): void {
  try {
    appendFileSync(p.waitDebugPath, `${new Date().toISOString()} pid=${process.pid} ${reason}\n`);
  } catch {
    /* best-effort */
  }
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
  const channel = new FsControlChannel(p);
  const store = new FsDocumentStore(p);

  // Cursor: explicit override, else the persisted cursor, else "start from now".
  // getCursor() returns 0 when unset, so `|| maxSeq` means begin at the latest seq.
  const cursor = explicitCursor ?? ((await channel.getCursor()) || maxSeq(p.logPath));

  const current = await store.loadDoc();
  let canonicalText = await store.getCanonical();
  if (canonicalText === null) {
    canonicalText = current;
    await store.setCanonical(current);
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
  // In Review mode an agent **body** change is quarantined as a proposal rather
  // than applied: the working file + canonical stay put, the agent's version is
  // parked in `.proposed.md`, and `agent_revision_proposed` is logged. The human
  // accepts/rejects in the editor (which then writes canonical). This makes the
  // file the source of truth WITHOUT auto-applying — killing the app before a
  // decision leaves the proposal pending, never silently accepted.
  const acceptance = currentAcceptance(p.logPath);
  const bodyChanged = parse(canonicalText).body !== parse(current).body;

  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects from the document and canonical base.
    await store.saveDoc(ev.acceptedText);
    await store.setCanonical(ev.acceptedText);
    await store.clearProposed();
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { removed: ev.removedIds } });
  } else if (ev.changed && acceptance === "review" && bodyChanged) {
    // Quarantine: park the proposal, revert the working file to canonical.
    await store.setProposed(current);
    await store.saveDoc(canonicalText);
    await channel.append({ actor: "agent", type: LogEventType.AgentRevisionProposed, payload: { bytes: current.length } });
  } else if (ev.changed) {
    // Auto-accept (auto mode, or review mode with comment-only changes).
    await store.setCanonical(current);
    await store.clearProposed();
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: current.length } });
  }

  // Signal the agent has (re)engaged this round so the editor can clear its
  // "Agent is thinking…" indicator even when the agent made no body change.
  await channel.append({ actor: "agent", type: LogEventType.AgentRevised });

  // Single-waiter lock: claim the doc so any older waiter steps down (no racing
  // double-waiters). Log the exit reason — including OS signals — so a reaped
  // waiter is diagnosable instead of "vanishing" silently.
  // Last writer wins — any older waiter sees the token change and steps down.
  const lockToken = `${process.pid}-${Date.now()}`;
  await channel.claimLock(lockToken);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(sig, () => {
      logWaitExit(p, `signal:${sig}`);
      process.exit(0);
    });
  }

  // Mode-aware wake: Turn mode wakes only on turn-end / session-close; Instant on any user action.
  const cadence = currentCadence(p.logPath);
  const isActionable = wakePredicate(cadence);
  const result = await waitForActions({ channel, cursor, debounceMs, pollMs, isActionable, token: lockToken });

  // Superseded: a newer waiter owns the doc now. Step down quietly without
  // advancing the cursor (the live waiter handles it).
  if (result.superseded) {
    logWaitExit(p, "superseded");
    output({ status: "superseded" });
    return;
  }

  await channel.setCursor(result.cursor); // advance the persisted cursor so the next call continues here

  // The editor logs WHY it closed (completed / window_closed); a crash logs nothing.
  const closeEntry = result.entries.find((e) => e.type === LogEventType.SessionClosed);
  // One status per situation:
  //   your_turn — Turn mode: human finished their turn and is LOCKED; revise, then
  //               call wait to hand control back.
  //   activity  — Instant mode: human is editing LIVE and is NOT blocked.
  //   closed    — the session ended; stop. `reason` says how: completed / window_closed
  //               / crashed_or_killed.
  let status: string;
  let reason: string | undefined;
  if (closeEntry) {
    status = "closed";
    reason = (closeEntry.payload as { reason?: string } | undefined)?.reason ?? "completed";
  } else if (result.editorGone) {
    status = "closed";
    reason = "crashed_or_killed";
  } else {
    status = cadence === "turn" ? "your_turn" : "activity";
  }
  logWaitExit(p, `status:${status}${reason ? `/${reason}` : ""}`);
  output({
    status,
    mode: cadence,
    humanLocked: status === "your_turn",
    // Materialized current settings (global file + this session's settings_changed),
    // so the agent always has them without scanning the log history.
    settings: currentSettings(p.logPath),
    ...(reason ? { reason } : {}),
    cursor: result.cursor,
    closed: status === "closed",
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
    process.stderr.write("usage: inplan <open|wait|signal> <file> [--cursor N] [--confirmed-comment-deletion=a,b] [--done] [--reload]\n");
    process.exit(64);
  }
  if (!file) {
    process.stderr.write(`inplan ${cmd}: missing <file>\n`);
    process.exit(64);
  }

  if (cmd === "signal") {
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    const channel = new FsControlChannel(p);
    if (hasFlag(rest, "done")) {
      await channel.append({ actor: "agent", type: LogEventType.AgentDoneSuggested });
    }
    // Ask the human to close the window so the agent can relaunch a new build —
    // a clean, user-initiated shutdown instead of the agent killing the process.
    if (hasFlag(rest, "reload")) {
      await channel.append({ actor: "agent", type: LogEventType.ReloadSuggested });
    }
    output({ status: "signaled" });
    return;
  }

  if (!existsSync(file)) {
    process.stderr.write(`inplan ${cmd}: file not found: ${file}\n`);
    process.exit(1);
  }

  if (cmd === "open") {
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    const existing = runningEditorPid(p.logPath);
    if (existing !== null) {
      process.stderr.write(`[inplan] an editor is already open for this document (pid ${existing}); attaching without launching another window\n`);
    } else {
      const pid = spawnApp(file);
      if (pid !== null) {
        await new FsControlChannel(p).append({ actor: "agent", type: LogEventType.EditorPid, payload: { pid, v: CONTROL_LOG_VERSION } });
      }
    }
  }

  await waitCycle(file, explicitCursor, confirmed);
}

main().catch((err) => {
  process.stderr.write(`inplan: ${(err as Error).message}\n`);
  process.exit(1);
});
