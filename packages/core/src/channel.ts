// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Deployment-portability seam. The file-based control mechanics
// (JSONL log, watch polling, `.waitlock`, sidecar versions) assume the agent and
// editor share one filesystem — true for the Electron desktop app, but not for a
// web service (different hosts, multi-user, no shared disk). Routing all control
// I/O through these interfaces lets the same `cli`/`app` run over a different
// backend (e.g. Supabase Realtime + Postgres for the web edition) by swapping the
// implementation. `core` stays pure — only the adapters touch I/O.

import type { LogEntry, NewLogEntry } from "./controlLog";

/** A unique token identifying one waiter, for the single-waiter lock. */
export type WaitToken = string;

/**
 * Wake signal + audit trail + single-waiter lock for one document. The fs
 * implementation wraps the JSONL log, the cursor/lock sidecars, and a file
 * watcher; a web implementation wraps a Supabase Realtime subscription, a row
 * cursor, and a Postgres advisory lock.
 */
export interface ControlChannel {
  /** Append one event; resolves to the stored entry (with assigned `seq`/`ts`). */
  append(event: NewLogEntry): Promise<LogEntry>;
  /** Entries appended after `cursor` (a `seq`), plus the new cursor. O(new). */
  readSince(cursor: number): Promise<{ entries: LogEntry[]; cursor: number }>;
  /** Subscribe to change notifications (push). Returns an unsubscribe fn. */
  subscribe(onChange: () => void): () => void;
  /** The persisted read cursor for this consumer (0 if never set). */
  getCursor(): Promise<number>;
  setCursor(seq: number): Promise<void>;
  /** Claim the single-waiter lock with `token` (most recent claimant wins). */
  claimLock(token: WaitToken): Promise<void>;
  /** True once a newer waiter has claimed the lock away from `token`. */
  isSuperseded(token: WaitToken): Promise<boolean>;
  /** Editor liveness — true if an editor is currently present for this doc. */
  presence(): Promise<boolean>;
}

/**
 * The document and its derived versions (canonical base, parked Review-mode
 * proposal, autosave backups). The fs implementation reads/writes sidecar files;
 * a web implementation reads/writes rows or Storage objects.
 */
/** Provenance for a backup checkpoint (who/why), so a history view can label it. All optional —
 *  a store may ignore it (the file backend does) and callers may omit it. */
export interface VersionMeta {
  /** Who produced the snapshotted state. */
  actor?: "user" | "agent";
  /** Why the snapshot was taken — e.g. "turn" (agent turn end), "manual" (human save), "restore". */
  kind?: string;
  /** Display author of the snapshotted state (e.g. the human's email or the agent's model id). */
  author?: string;
}

export interface DocumentStore {
  /** Read the working document. */
  loadDoc(): Promise<string>;
  /** Write the working document. */
  saveDoc(content: string): Promise<void>;
  /** The last canonical version (diff base / undo base), or null if unset. */
  getCanonical(): Promise<string | null>;
  setCanonical(content: string): Promise<void>;
  /** The parked agent revision pending accept/reject (Review mode), or null. */
  getProposed(): Promise<string | null>;
  setProposed(content: string): Promise<void>;
  clearProposed(): Promise<void>;
  /** Write an autosave backup checkpoint. `meta` (optional) records its provenance for a history
   *  view; an implementation that keeps history should de-duplicate (skip a no-op snapshot whose
   *  body matches the most recent one). */
  backup(content: string, meta?: VersionMeta): Promise<void>;
}
