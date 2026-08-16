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
//   <docId>.plan.md.proposed.json  the AUTHORITATIVE proposal record + its exact text,
//                                  published atomically (tmp + rename)
//   <docId>.plan.md.proposed.md    a derived, read-convenience copy of the proposed text
//   <docId>.plan.md.proposals.jsonl  append-only history of finalized records (never pruned;
//                                  metadata only — accepted text lives in canonical history)
//
// The proposal record is the durable half of the landing signal: `agent_revision_proposed`
// appears in exactly one wait output (the cursor advances past it), so an agent auditing a
// turn later needs state on disk. Persistence is deliberately crash-shaped:
//  - the record and its text publish as ONE atomic rename, so no torn write-pair can ever
//    advertise a proposal without its text (or vice versa);
//  - each park carries a unique `id`, so history idempotency and supersede detection never
//    confuse two proposals that happen to share content;
//  - anything this machine still misses after a crash is reconciled from the CLOUD's proposed
//    slot at the next attach (see `needsReparkFromSlot`) — the slot is the authoritative side
//    of the push, so it, not local heuristics, is the recovery source.

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
  /** Unique per park (content may repeat; identity must not). */
  id: string;
  docId: string;
  /** hashBody of the full proposed text (comments included — same hash family as `.synced`). */
  hash: string;
  /** UTF-8 byte length of the proposed text, matching the `agent_revision_proposed` payload. */
  bytes: number;
  /** ISO-8601 park time. */
  at: string;
  state: "pending_review" | ProposalOutcome;
  /** Set when the cloud slot was seen empty but no decision event was readable yet — the record
   *  stays pending for one more look before degrading to `decided`, so a slot-clear racing ahead
   *  of its decision event can't permanently erase the real outcome. */
  awaitingOutcomeSince?: string;
}

/** The persisted shape of `.proposed.json`: the record plus its exact text, one atomic unit. */
interface StoredProposal extends ProposalRecord {
  text: string;
}

/**
 * Map decision events to THIS proposal's outcome, newest-first so the human's most recent decision
 * wins. Binding is by the log's own order, not the clock: the park appended
 * `agent_revision_proposed` carrying the proposal's hash, so the decision window is (this park's
 * event, the next park event] — decisions for a LATER proposal (parked and decided by another
 * machine while this one was offline) can never be misattributed to this record. When no event
 * carries this hash (the append failed, or an older CLI wrote no hash), the anchor degrades to
 * the newest park event that does not POSTDATE this record's park time — a later machine's park
 * must not become our window — and the timestamp filter stays on inside a weak window, preferring
 * a degraded "decided" over finalizing this record with another proposal's outcome.
 */
export function resolutionFromEvents(entries: LogEntry[], park: { at: string; hash: string }): ProposalOutcome {
  const parkedAt = Date.parse(park.at);
  let start = -1;
  let matched = false;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.type !== LogEventType.AgentRevisionProposed) continue;
    // Any candidate — hash-matched or weak — must plausibly BE this park: an event stamped after
    // our recorded park time (5s slack for CLI-vs-server clock disagreement) is someone else's
    // LATER park, even when its content hash matches ours (identical text is not identity — a
    // newer proposal repeating our text must not donate its decision window to this record).
    const ts = Date.parse(e.ts);
    if (Number.isFinite(parkedAt) && Number.isFinite(ts) && ts > parkedAt + 5_000) continue;
    if ((e.payload as { hash?: unknown } | undefined)?.hash === park.hash) {
      start = i;
      matched = true;
      break;
    }
    if (start < 0) start = i; // newest eligible park: the weak-anchor candidate
  }
  // The window closes at the NEXT park event after the anchor: decisions beyond it belong to a
  // newer proposal. This applies even with NO anchor (every park event postdates us): the first
  // park event still starts someone else's window, and a later proposal's decision carries a
  // later timestamp too — the timestamp filter alone could not exclude it.
  let end = entries.length;
  for (let i = start + 1; i < entries.length; i++) {
    if (entries[i]!.type === LogEventType.AgentRevisionProposed) {
      end = i;
      break;
    }
  }
  for (let i = end - 1; i > start; i--) {
    const e = entries[i]!;
    if (!matched) {
      const ts = Date.parse(e.ts);
      if (Number.isFinite(parkedAt) && Number.isFinite(ts) && ts < parkedAt) break;
    }
    if (e.type === LogEventType.RevisionAcceptedAll) return "accepted";
    if (e.type === LogEventType.RevisionRejectedAll) return "rejected";
    if (e.type === LogEventType.RevisionHunkAccepted || e.type === LogEventType.RevisionHunkRejected) return "partially_accepted";
  }
  return "decided";
}

/**
 * Whether the CLOUD's proposed slot holds a proposal this machine has no live record of — the
 * reconciliation check run at attach. True when a slot exists but the latest local record is
 * absent, terminal, or about different content: whatever local write was lost (a crash between
 * the confirmed push and the record publish, a re-park of identical text after a finalization),
 * re-parking the slot's own text recreates the truthful pending record from the authoritative
 * side. Cheap and idempotent — a healthy pending record simply returns false.
 */
export function needsReparkFromSlot(latest: ProposalRecord | null, slotText: string | null | undefined): boolean {
  if (typeof slotText !== "string") return false;
  return latest === null || latest.state !== "pending_review" || latest.hash !== hashBody(slotText);
}

/**
 * Whether the working copy is the CORPSE of a decided proposal: its content equals a terminal
 * record's text (the post-turn re-sync never ran before the process died). Hydration normally
 * protects a diverged working copy as "unsynced agent edits" — but this copy is not an edit to
 * preserve, it is content the human already decided; keeping it would make the next turn re-park
 * a rejected proposal. The caller restores canonical instead (the decision stands).
 */
export function isDecidedProposalCorpse(latest: ProposalRecord | null, currentContent: string | null): boolean {
  if (!latest || latest.state === "pending_review" || currentContent === null) return false;
  return hashBody(currentContent) === latest.hash;
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
   * Park a proposal: publish the record + its exact text as ONE atomic rename, then refresh the
   * derived `.proposed.md` copy (best-effort — the JSON is authoritative). A still-pending
   * previous record about different content is finalized into the history as `superseded` first,
   * so no record is ever silently lost; re-parking identical content keeps the existing pending
   * identity (same proposal, re-pushed) instead of minting a new one.
   */
  parkProposal(text: string, at: Date = new Date()): ProposalRecord {
    const prior = this.pendingProposal();
    const hash = hashBody(text);
    if (prior && prior.hash === hash) {
      // Same proposal, re-pushed. A stale awaiting-outcome marker must not survive the re-push:
      // the slot is live again, so a later slot-clear deserves the full grace before degrading
      // to 'decided', not an immediate finalization off the old sighting.
      if (prior.awaitingOutcomeSince) {
        const { awaitingOutcomeSince: _stale, ...rest } = prior;
        this.publish({ ...rest, text });
        return rest;
      }
      this.writeDerivedText(text);
      return prior;
    }
    if (prior) this.finalize(prior, "superseded");
    const record: ProposalRecord = {
      id: `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      docId: this.docId,
      hash,
      bytes: utf8Bytes(text),
      at: at.toISOString(),
      state: "pending_review",
    };
    this.publish({ ...record, text });
    return record;
  }

  /** The latest record regardless of state, or null — missing, unreadable, or failing the full
   *  shape check (wrong doc, non-numeric bytes, unparseable park time, unknown state). A partial
   *  record must read as absent, or it could be finalized with missing metadata. */
  latestProposal(): ProposalRecord | null {
    const stored = this.readStored();
    if (!stored) return null;
    const { text: _text, ...record } = stored;
    return record;
  }

  /** The latest record only while it awaits the human's decision. */
  pendingProposal(): ProposalRecord | null {
    const record = this.latestProposal();
    return record?.state === "pending_review" ? record : null;
  }

  /** The latest proposal's exact pushed text (recovery path after the working-copy re-sync). */
  proposedText(): string | null {
    return this.readStored()?.text ?? null;
  }

  /**
   * First sighting of "slot empty but no decision event readable yet": mark the record instead of
   * finalizing, so a slot-clear that races ahead of its decision event gets one more run to
   * surface the real outcome. Returns the updated record (or null when nothing is pending).
   */
  noteOutcomeMissing(at: Date = new Date()): ProposalRecord | null {
    const stored = this.readStored();
    if (!stored || stored.state !== "pending_review" || stored.awaitingOutcomeSince) return null;
    const updated: StoredProposal = { ...stored, awaitingOutcomeSince: at.toISOString() };
    this.publish(updated);
    const { text: _text, ...record } = updated;
    return record;
  }

  /**
   * Finalize the pending record with the human's decision: append it to the never-pruned history
   * log FIRST (metadata only — an accepted text's fate is canonical history's job), then
   * republish the record. A crash between the writes leaves the record pending, so the next
   * resolution retries — and the retry is idempotent because the history tail already carries
   * this park's unique id.
   */
  resolveProposal(outcome: ProposalOutcome): ProposalRecord | null {
    const pending = this.pendingProposal();
    if (!pending) return null;
    return this.finalize(pending, outcome);
  }

  private finalize(record: ProposalRecord, outcome: ProposalOutcome): ProposalRecord {
    const { awaitingOutcomeSince: _grace, ...rest } = record;
    const finalized: ProposalRecord = { ...rest, state: outcome };
    const tail = this.historyTail();
    if (!tail || tail.id !== finalized.id) appendFileSync(this.historyPath, `${JSON.stringify(finalized)}\n`);
    const stored = this.readStored();
    this.publish({ ...finalized, text: stored?.id === finalized.id ? stored.text : "" });
    return finalized;
  }

  // ── Persistence primitives ────────────────────────────────────────────────────────────────────

  /** Atomic publish: the record + text land as one rename, then the derived .md refreshes. */
  private publish(stored: StoredProposal): void {
    const tmp = `${this.recordPath}.tmp`;
    writeFileSync(tmp, JSON.stringify(stored, null, 2));
    renameSync(tmp, this.recordPath);
    this.writeDerivedText(stored.text);
  }

  private writeDerivedText(text: string): void {
    try {
      writeFileSync(this.textPath, text);
    } catch {
      /* derived copy only — the authoritative text is inside .proposed.json */
    }
  }

  private readStored(): StoredProposal | null {
    if (!existsSync(this.recordPath)) return null;
    try {
      const p = JSON.parse(readFileSync(this.recordPath, "utf8")) as Partial<StoredProposal>;
      const validState = p.state === "pending_review" || p.state === "accepted" || p.state === "partially_accepted" || p.state === "rejected" || p.state === "decided" || p.state === "superseded";
      if (typeof p.id !== "string" || p.docId !== this.docId || typeof p.hash !== "string" || !Number.isInteger(p.bytes) || (p.bytes as number) < 0 || !Number.isFinite(Date.parse(p.at ?? "")) || !validState || typeof p.text !== "string") return null;
      // A PENDING record's text is load-bearing (recovery, re-push, slot comparison), so a
      // valid-JSON-but-corrupted record whose hash/bytes disagree with its own text reads as
      // absent — reconciliation from the cloud slot rebuilds the truth. Finalized records
      // tolerate the mismatch: their text is historical convenience, not a recovery input.
      if (p.state === "pending_review" && (hashBody(p.text) !== p.hash || utf8Bytes(p.text) !== p.bytes)) return null;
      return p as StoredProposal;
    } catch {
      return null;
    }
  }

  /** The history log's last finalized record, or null (absent/unreadable/invalid). Reads only the
   *  file's tail — the log is never pruned, so a whole-file read would grow without bound. */
  private historyTail(): ProposalRecord | null {
    if (!existsSync(this.historyPath)) return null;
    try {
      const fd = openSync(this.historyPath, "r");
      let chunk: string;
      try {
        const size = fstatSync(fd).size;
        const span = Math.min(size, 16_384); // far above any single metadata line
        const buf = Buffer.alloc(span);
        readSync(fd, buf, 0, span, size - span);
        chunk = buf.toString("utf8");
      } finally {
        closeSync(fd);
      }
      const lines = chunk.trim().split("\n");
      const last = JSON.parse(lines[lines.length - 1]!) as Partial<ProposalRecord>;
      if (typeof last.id !== "string" || last.docId !== this.docId || typeof last.hash !== "string" || typeof last.state !== "string") return null;
      return last as ProposalRecord;
    } catch {
      return null;
    }
  }
}
