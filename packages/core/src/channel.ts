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

/** Optional metadata for an {@link ControlChannel.append}. `userId` attributes the event to a
 *  human (used by metered backends for per-user usage accounting); backends with nowhere to store
 *  it ignore it. */
export interface AppendOptions {
  userId?: string;
}

/**
 * Wake signal + audit trail + single-waiter lock for one document. The fs
 * implementation wraps the JSONL log, the cursor/lock sidecars, and a file
 * watcher; a web implementation wraps a Supabase Realtime subscription, a row
 * cursor, and a Postgres advisory lock.
 */
export interface ControlChannel {
  /** Append one event; resolves to the stored entry (with assigned `seq`/`ts`). `opts.userId`
   *  attributes the event to a human (metered backends use it for usage accounting); backends
   *  without a place to store it ignore the option. */
  append(event: NewLogEntry, opts?: AppendOptions): Promise<LogEntry>;
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
  /** Editor liveness. With no argument: true if an editor is present now (within the backend's
   *  heartbeat TTL). With `sinceMs` (epoch ms): true only if the liveness signal is FRESHER than
   *  `sinceMs` — used when watching for a reopen so a pre-close heartbeat still lingering inside
   *  its TTL isn't mistaken for the editor coming back. */
  presence(sinceMs?: number): Promise<boolean>;
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

/** How a proposal's life ends (or hasn't yet). Terminal states are immutable. */
export type ProposalState = "pending" | "accepted" | "partially_accepted" | "rejected" | "superseded" | "withdrawn";

/** What a proposer parks (proposals v1 — see docs/proposals-v1.plan.md in the cloud repo). */
export interface ProposalInput {
  /** Client-minted uuid. Re-parking with the SAME id is an idempotent upsert (a retried park
   *  converges even when an earlier response was lost). When omitted, identical still-pending
   *  content re-parks under ITS existing id (a retry, not a successor); only genuinely new
   *  content mints a fresh identity. */
  id?: string;
  /** The full proposed serialization. */
  content: string;
  /** hashBody of the canonical this proposal was written against. */
  baseHash: string;
  /** The base canonical itself — a 3-way merge at review time must never depend on a version
   *  checkpoint happening to exist for `baseHash`. */
  baseContent: string;
}

export interface ProposalRow {
  id: string;
  content: string;
  baseHash: string;
  baseContent: string;
  state: ProposalState;
  /** ISO-8601. */
  createdAt: string;
  decidedAt?: string;
}

/** Mint a proposal id (uuid) — client-generated so retries are idempotent by construction. */
export function mintProposalId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  // Fallback for runtimes without randomUUID: still RFC-4122 v4 SHAPED — the id lands in a
  // Postgres uuid column, which rejects anything else. Uniqueness (not unguessability) is the
  // requirement here; ids are scoped per doc and authorization never derives from them.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16);
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => (ch === "x" ? hex(16) : ((Math.floor(Math.random() * 4) + 8).toString(16))));
}

export interface DocumentStore {
  /** Read the working document. */
  loadDoc(): Promise<string>;
  /** Write the working document. */
  saveDoc(content: string): Promise<void>;
  /** The last canonical version (diff base / undo base), or null if unset. */
  getCanonical(): Promise<string | null>;
  setCanonical(content: string): Promise<void>;
  /** Park a proposal (Review mode): upsert by id — the same id converges, a NEW id supersedes the
   *  caller's own previous pending proposal. Never touches another proposer's proposals. */
  createProposal(input: ProposalInput): Promise<{ id: string }>;
  /** The caller's own pending proposal, or null. */
  myPendingProposal(): Promise<ProposalRow | null>;
  /** Any visible proposal by id — the landing signal, as one lookup. */
  getProposal(id: string): Promise<ProposalRow | null>;
  /** Retract the caller's own pending proposal (state → withdrawn). No-op when it isn't pending
   *  (a decision may have raced ahead — the decision wins). */
  withdrawProposal(id: string): Promise<void>;
  /** Record the human's decision on a pending proposal. No-op on a non-pending row (terminal
   *  states are immutable). */
  decideProposal(id: string, state: "accepted" | "partially_accepted" | "rejected"): Promise<void>;
  /** Write an autosave backup checkpoint. `meta` (optional) records its provenance for a history
   *  view; an implementation that keeps history should de-duplicate (skip a no-op snapshot whose
   *  body matches the most recent one). */
  backup(content: string, meta?: VersionMeta): Promise<void>;
}
