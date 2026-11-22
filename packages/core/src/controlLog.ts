// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Browser-safe control-log types and pure (de)serialization. The fs-backed
// readers/writers live in `./controlLogFs` (Node only), exposed via the
// `@inplan/core/node` entry — keeping this package root importable in a
// browser/renderer bundle.

/**
 * Control-log schema version. Stamped into the `editor_pid` event each session
 * starts, so a reader can detect the format a log was written with and migrate
 * older logs rather than guess. Bump on an incompatible log-format change.
 */
export const CONTROL_LOG_VERSION = 1;

/** Who performed a logged action. */
export type Actor = "user" | "agent";

/** Canonical control-log event types (the agent's wake signal + audit trail). */
export const LogEventType = {
  EditorPid: "editor_pid",
  ModeChanged: "mode_changed",
  CommentCreated: "comment_created",
  CommentModified: "comment_modified",
  CommentDeleted: "comment_deleted",
  CommentResolved: "comment_resolved",
  CommentAnswered: "comment_answered",
  DocumentEdited: "document_edited",
  TurnEnded: "turn_ended",
  AgentRevised: "agent_revised",
  AgentRevisionProposed: "agent_revision_proposed",
  RevisionHunkAccepted: "revision_hunk_accepted",
  RevisionHunkRejected: "revision_hunk_rejected",
  RevisionAcceptedAll: "revision_accepted_all",
  RevisionRejectedAll: "revision_rejected_all",
  SettingsChanged: "settings_changed",
  AgentDoneSuggested: "agent_done_suggested",
  ReloadSuggested: "reload_suggested",
  /** A human-facing note the agent relayed to the editor (payload `{ text }`),
   *  surfaced in the status bar. Informational only — not a wake signal. */
  AgentMessage: "agent_message",
  /** Cloud→local handoff: a human on the web asked the attached local agent to
   *  bring the doc back to disk (the inverse of "Collaborate on Cloud"). */
  SaveLocallyRequested: "save_locally_requested",
  /** Turn-mode escape: the human reclaimed control after the agent failed to hand it back. */
  HumanReclaimed: "human_reclaimed",
  /** In-window navigation: the editor followed a Markdown link to a sibling doc.
   *  Payload `{ path }` is the new doc; the attached agent's `wait` steps down and
   *  the human's agent re-attaches there (the local analogue of save-locally). */
  NavigatedTo: "navigated_to",
  SessionClosed: "session_closed",
  /** `inplan open` created this document on an agent's behalf (it was passed `--model`) and the
   *  agent is about to write the first draft. Payload `{ model }`. The editor shows a dismissible
   *  "may be writing the first draft" banner while the body is still empty, so the empty page
   *  doesn't read as a broken load. Informational only — not a wake signal. */
  DraftPending: "draft_pending",
} as const;

export type LogEventTypeValue = (typeof LogEventType)[keyof typeof LogEventType];

/** One line of the append-only control log. */
export interface LogEntry<T = unknown> {
  /** Monotonic sequence number / cursor (1-based). */
  seq: number;
  /** ISO-8601 timestamp. */
  ts: string;
  actor: Actor;
  type: string;
  payload?: T;
}

/** A new entry without the fields the log assigns (`seq`; `ts` optional). */
export type NewLogEntry<T = unknown> = Omit<LogEntry<T>, "seq" | "ts"> & { ts?: string };

/** Serialize an entry to a single JSONL line (no trailing newline). */
export function serializeLogEntry(entry: LogEntry): string {
  return JSON.stringify(entry);
}

/** Parse a single non-empty JSONL line into a LogEntry. */
export function parseLogLine(line: string): LogEntry {
  return JSON.parse(line) as LogEntry;
}

/** Parse a whole control-log text into entries (ignoring blank lines). */
export function parseLog(text: string): LogEntry[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map(parseLogLine);
}

/** The model an agent named when it created this document with `inplan open`, while its first draft
 *  is still to come — read off the control log; null otherwise. The log is never reset, so the
 *  draft_pending entry must be retired by whatever ends that expectation: the draft arriving (the
 *  agent's document_edited, or agent_revision_proposed when parked for review), the session it was
 *  raised in closing, or the human saving the document. Otherwise an agent that died before writing,
 *  or a page the human later cleared, would bring the banner back on some later open.
 *
 *  NOT agent_revised: every wait — including the one `inplan open` runs straight after launching the
 *  editor — logs it as a turn marker whether or not anything was written, so treating it as the
 *  draft arriving retired the banner before the editor ever loaded. */
export function draftPendingFrom(entries: readonly LogEntry[]): { model: string } | null {
  let model: string | null = null;
  for (const e of entries) {
    if (e.type === LogEventType.DraftPending) {
      const m = (e.payload as { model?: unknown } | undefined)?.model;
      model = typeof m === "string" && m.trim() ? m : null;
    } else if (e.actor === "agent" && (e.type === LogEventType.DocumentEdited || e.type === LogEventType.AgentRevisionProposed)) {
      model = null; // the draft has arrived (landed, or parked for review)
    } else if (e.type === LogEventType.SessionClosed) {
      model = null; // that session is over: a later open has no agent drafting on its behalf
    } else if (e.actor === "user" && (e.type === LogEventType.DocumentEdited || e.type === LogEventType.TurnEnded)) {
      // The human saved (a save needs a change first). Read only on a LATER load, so it never pulls
      // a banner off the screen it is on. (Not by byte count: an empty document serializes non-empty.)
      model = null;
    }
  }
  return model ? { model } : null;
}
