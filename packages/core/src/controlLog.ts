// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Browser-safe control-log types and pure (de)serialization. The fs-backed
// readers/writers live in `./controlLogFs` (Node only), exposed via the
// `@agent-planner/core/node` entry — keeping this package root importable in a
// browser/renderer bundle.

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
  SessionClosed: "session_closed",
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
