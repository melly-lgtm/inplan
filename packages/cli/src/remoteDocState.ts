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
//  - anything this machine still misses after a crash is reconciled from the CLOUD's proposal
//    ROW at the next attach — the record's id is the row's id (proposals v1), so recovery is a
//    lookup of the authoritative side, never a local heuristic.

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { hashBody } from "@inplan/core/node";
import type { HydrateInput } from "./liveSync";

/** How a pending proposal ended. `accepted`/`partially_accepted`/`rejected`/`superseded`/
 *  `withdrawn` mirror the cloud row's terminal state verbatim. `decided` = the row itself is
 *  gone (a legacy or purged proposal with no row to name the outcome) — the human acted; which
 *  way is unknown. */
export type ProposalOutcome = "accepted" | "partially_accepted" | "rejected" | "decided" | "superseded" | "withdrawn";

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
}

/** The persisted shape of `.proposed.json`: the record plus its exact text, one atomic unit. */
interface StoredProposal extends ProposalRecord {
  text: string;
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
  parkProposal(text: string, at: Date = new Date(), id?: string): ProposalRecord {
    const prior = this.pendingProposal();
    const hash = hashBody(text);
    if (prior && id !== undefined && id === prior.id && prior.hash !== hash) {
      // Same identity, updated content (the cloud converge-if-pending path): the record follows
      // in place. Superseding here would finalize the id into the history and then republish the
      // SAME id as pending — breaking terminal immutability and corrupting the history. `at`
      // stays the ORIGINAL park time — it documents when the proposal was parked, not when a
      // reconciliation last touched the record.
      const updated: ProposalRecord = { ...prior, hash, bytes: utf8Bytes(text) };
      this.publish({ ...updated, text });
      return updated;
    }
    if (prior && prior.hash === hash && (id === undefined || id === prior.id)) {
      // Same proposal, re-pushed: keep the existing pending identity.
      this.writeDerivedText(text);
      return prior;
    }
    if (prior) this.finalize(prior, "superseded");
    const record: ProposalRecord = {
      // The id is the CLOUD row's id when the caller passes one (proposals v1 — one identity end
      // to end); minted locally only for offline/desktop parks.
      id: id ?? `${at.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
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
    const finalized: ProposalRecord = { ...record, state: outcome };
    // Idempotency is by identity AND outcome: a crash-retried finalization with the same result
    // appends nothing, but a retry that resolved to a DIFFERENT outcome appends the correction —
    // the history must never disagree with the record it claims to log.
    const tail = this.historyTail();
    if (!tail || tail.id !== finalized.id || tail.state !== finalized.state) appendFileSync(this.historyPath, `${JSON.stringify(finalized)}\n`);
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
      const validState = p.state === "pending_review" || p.state === "accepted" || p.state === "partially_accepted" || p.state === "rejected" || p.state === "decided" || p.state === "superseded" || p.state === "withdrawn";
      if (typeof p.id !== "string" || p.docId !== this.docId || typeof p.hash !== "string" || !Number.isInteger(p.bytes) || (p.bytes as number) < 0 || !Number.isFinite(Date.parse(p.at ?? "")) || !validState || typeof p.text !== "string") return null;
      // A PENDING record's text is load-bearing (recovery, re-push, row comparison), so a
      // valid-JSON-but-corrupted record whose hash/bytes disagree with its own text reads as
      // absent — reconciliation from the cloud row rebuilds the truth. Finalized records
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
