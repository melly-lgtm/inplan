// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Per-doc sidecar state for the live-collab (remote) working copy — the single owner of the
// file layout under `~/.inplan/sidecars/remote/`. `runRemote` used to open-code every one of
// these files inline; concentrating them here gives the "did my edit land?" state one tested
// seam (#88). On disk everything is a flat sibling of the working copy, and `.synced` keeps
// its exact legacy format (a bare hash string), so older CLIs interoperate unchanged:
//
//   <docId>.plan.md                 the working copy the agent reads/edits
//   <docId>.plan.md.pending        marker: a local fallback edit awaits a hub push
//   <docId>.plan.md.synced         hash of the working copy at our last write/sync
//   <docId>.plan.md.proposed.json  the latest proposal record (see ProposalRecord)
//   <docId>.plan.md.proposed.md    the latest proposal's exact pushed text
//   <docId>.plan.md.proposals.jsonl  append-only history of finalized records (never pruned)
//
// The proposal record is the durable half of the landing signal: `agent_revision_proposed`
// appears in exactly one wait output (the cursor advances past it), so an agent auditing a
// turn later needs state on disk. The record is written BEFORE the end-of-turn re-sync
// overwrites the working copy with canonical, so a parked edit is always recoverable from
// `.proposed.md` — the clobber that made the 2026-08-11 work-deletion inevitable no longer
// destroys the only local copy.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashBody, LogEventType, type LogEntry } from "@inplan/core/node";
import type { HydrateInput } from "./liveSync";

/** How a pending proposal ended. `decided` = the proposed slot emptied but no decision event was
 *  readable (the human acted; which way is unknown). `superseded` = a newer park replaced it. */
export type ProposalOutcome = "accepted" | "partially_accepted" | "rejected" | "decided" | "superseded";

/** UTF-8 byte length — the one sizing used by the proposal record, the wait output's `proposal`
 *  field, and the `agent_revision_proposed` payload, so the three never disagree. */
export const utf8Bytes = (text: string): number => Buffer.byteLength(text, "utf8");

export interface ProposalRecord {
  docId: string;
  /** hashBody of the full proposed text (comments included — same hash family as `.synced`). */
  hash: string;
  /** UTF-8 byte length of the proposed text, matching the `agent_revision_proposed` payload. */
  bytes: number;
  /** ISO-8601 park time. */
  at: string;
  state: "pending_review" | ProposalOutcome;
}

/**
 * Map the decision events since a park to the proposal's outcome, newest-first so the human's most
 * recent decision wins. The park boundary is the log's own order, not the clock: the park appended
 * `agent_revision_proposed`, and only one proposal pends at a time, so everything after the LAST
 * such event belongs to this park. Timestamp comparison against the recorded park time is only the
 * fallback for a park whose event append failed — there, CLI-clock vs server-timestamp skew can at
 * worst degrade a fast decision to "decided", never misattribute an old one.
 */
export function resolutionFromEvents(entries: LogEntry[], parkedAtIso: string): ProposalOutcome {
  let boundary = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.AgentRevisionProposed) {
      boundary = i;
      break;
    }
  }
  const parkedAt = Date.parse(parkedAtIso);
  for (let i = entries.length - 1; i > boundary; i--) {
    const e = entries[i]!;
    if (boundary < 0) {
      const ts = Date.parse(e.ts);
      if (Number.isFinite(parkedAt) && Number.isFinite(ts) && ts < parkedAt) break;
    }
    if (e.type === LogEventType.RevisionAcceptedAll) return "accepted";
    if (e.type === LogEventType.RevisionRejectedAll) return "rejected";
    if (e.type === LogEventType.RevisionHunkAccepted || e.type === LogEventType.RevisionHunkRejected) return "partially_accepted";
  }
  return "decided";
}

export class RemoteDocState {
  /** Marker: a local fallback edit awaits a hub push (public — liveSync's replay decision reads it). */
  readonly pendingPath: string;
  private readonly hashPath: string;
  private readonly recordPath: string;
  private readonly textPath: string;
  private readonly historyPath: string;

  constructor(
    readonly workFile: string,
    private readonly docId: string,
  ) {
    this.pendingPath = `${workFile}.pending`;
    this.hashPath = `${workFile}.synced`;
    this.recordPath = `${workFile}.proposed.json`;
    this.textPath = `${workFile}.proposed.md`;
    this.historyPath = `${workFile}.proposals.jsonl`;
  }

  ensureDir(): void {
    mkdirSync(dirname(this.workFile), { recursive: true });
  }

  // ── Working copy + canonical-sync hash (legacy formats, unchanged) ────────────────────────────

  readWorkFile(): string | null {
    return existsSync(this.workFile) ? readFileSync(this.workFile, "utf8") : null;
  }

  writeWorkFile(content: string): void {
    writeFileSync(this.workFile, content);
  }

  /** Record that the working copy now equals `content` (our last write/sync). */
  recordSynced(content: string): void {
    writeFileSync(this.hashPath, hashBody(content));
  }

  /** Assemble the start-of-turn hydration decision's input (see liveSync.shouldHydrateWorkFile). */
  hydrateInput(): HydrateInput {
    const current = this.readWorkFile();
    return {
      exists: current !== null,
      pending: this.replayPending(),
      currentHash: current !== null ? hashBody(current) : null,
      syncedHash: existsSync(this.hashPath) ? readFileSync(this.hashPath, "utf8") : null,
    };
  }

  // ── Hub-push replay marker (legacy `.pending`, unchanged) ─────────────────────────────────────

  replayPending(): boolean {
    return existsSync(this.pendingPath);
  }

  markReplayPending(): void {
    writeFileSync(this.pendingPath, "1");
  }

  clearReplayPending(): void {
    if (existsSync(this.pendingPath)) rmSync(this.pendingPath);
  }

  // ── Proposal record: the durable "did my edit land?" signal (#88) ─────────────────────────────

  /**
   * Park a proposal: write the record (`pending_review`) and the exact pushed text. Call BEFORE
   * anything overwrites the working copy. A still-pending previous record with a different hash is
   * finalized into the history as `superseded` first, so no record is ever silently lost.
   */
  parkProposal(text: string, at: Date = new Date()): ProposalRecord {
    const prior = this.pendingProposal();
    if (prior && prior.hash !== hashBody(text)) this.finalize(prior, "superseded");
    const record: ProposalRecord = {
      docId: this.docId,
      hash: hashBody(text),
      bytes: utf8Bytes(text),
      at: at.toISOString(),
      state: "pending_review",
    };
    // Text first, record last: the record is the publish point, so a process killed between the
    // two writes leaves an unadvertised text file — never a pending_review record whose text is
    // missing (which would defeat the recovery path the record exists to provide).
    writeFileSync(this.textPath, text);
    writeFileSync(this.recordPath, JSON.stringify(record, null, 2));
    return record;
  }

  /** The latest record regardless of state, or null — missing, unreadable, or failing the full
   *  shape check (wrong doc, non-numeric bytes, unparseable park time, unknown state). A partial
   *  record must read as absent, or it could be finalized with missing metadata. */
  latestProposal(): ProposalRecord | null {
    if (!existsSync(this.recordPath)) return null;
    try {
      const p = JSON.parse(readFileSync(this.recordPath, "utf8")) as Partial<ProposalRecord>;
      const validState = p.state === "pending_review" || p.state === "accepted" || p.state === "partially_accepted" || p.state === "rejected" || p.state === "decided" || p.state === "superseded";
      if (p.docId !== this.docId || typeof p.hash !== "string" || typeof p.bytes !== "number" || !Number.isFinite(Date.parse(p.at ?? "")) || !validState) return null;
      return p as ProposalRecord;
    } catch {
      return null;
    }
  }

  /** The latest record only while it awaits the human's decision. */
  pendingProposal(): ProposalRecord | null {
    const record = this.latestProposal();
    return record?.state === "pending_review" ? record : null;
  }

  /** The latest proposal's exact pushed text (recovery path after the working-copy re-sync). */
  proposedText(): string | null {
    return existsSync(this.textPath) ? readFileSync(this.textPath, "utf8") : null;
  }

  /**
   * Finalize the pending record with the human's decision: rewrite its state in place (the latest
   * outcome stays one `cat` away) and append it to the never-pruned history log.
   */
  resolveProposal(outcome: ProposalOutcome): ProposalRecord | null {
    const pending = this.pendingProposal();
    if (!pending) return null;
    return this.finalize(pending, outcome);
  }

  private finalize(record: ProposalRecord, outcome: ProposalOutcome): ProposalRecord {
    const finalized: ProposalRecord = { ...record, state: outcome };
    writeFileSync(this.recordPath, JSON.stringify(finalized, null, 2));
    appendFileSync(this.historyPath, `${JSON.stringify(finalized)}\n`);
    return finalized;
  }
}
