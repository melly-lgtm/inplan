// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RemoteDocState — the durable "did my edit land?" state (#88). The properties pinned here are
// the ones whose absence caused the 2026-08-11 work-deletion: a parked proposal must survive the
// end-of-turn working-copy overwrite, must be auditable turns later, and must mirror the human's
// actual decision (the cloud row's terminal state), never silently vanish.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hashBody } from "@inplan/core/node";
import { RemoteDocState, isDecidedProposalCorpse, utf8Bytes } from "../src/remoteDocState";
import { shouldHydrateWorkFile } from "../src/liveSync";

let dir: string;
let s: RemoteDocState;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplan-rds-"));
  s = new RemoteDocState(join(dir, "remote", "doc-1.plan.md"), "doc-1");
  s.ensureDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("park / audit / resolve", () => {
  it("a retried finalization with a DIFFERENT outcome appends the correction to the history", () => {
    s.parkProposal("v1");
    s.resolveProposal("accepted");
    const historyPath = join(dir, "remote", "doc-1.plan.md.proposals.jsonl");
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    // Crash window: history has 'accepted', the record republish never ran — and the retry
    // resolves differently this time. The history must follow the record, not silently disagree.
    const stored = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...stored, state: "pending_review" }, null, 2));
    s.resolveProposal("rejected");
    const lines = readFileSync(historyPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[1]!)).toMatchObject({ id: stored.id, state: "rejected" });
    expect(s.latestProposal()?.state).toBe("rejected"); // record and history tail agree
  });
  it("a parked proposal survives the end-of-turn working-copy overwrite (the #88 clobber)", () => {
    s.writeWorkFile("agent's 48KB of work");
    s.parkProposal("agent's 48KB of work");
    // The end-of-turn re-sync then overwrites the working copy with the pre-edit canonical:
    s.writeWorkFile("pre-edit canonical");
    s.recordSynced("pre-edit canonical");

    const pending = s.pendingProposal();
    expect(pending?.state).toBe("pending_review");
    expect(pending?.hash).toBe(hashBody("agent's 48KB of work"));
    expect(s.proposedText()).toBe("agent's 48KB of work"); // the recovery path
  });

  it("resolve rewrites the record in place AND appends to the never-pruned history", () => {
    s.parkProposal("v1");
    s.resolveProposal("accepted");
    expect(s.latestProposal()?.state).toBe("accepted");
    expect(s.pendingProposal()).toBeNull();

    s.parkProposal("v2");
    s.resolveProposal("rejected");
    const history = readFileSync(join(dir, "remote", "doc-1.plan.md.proposals.jsonl"), "utf8").trim().split("\n");
    expect(history).toHaveLength(2); // kept forever — nothing pruned
    expect(JSON.parse(history[0]!).state).toBe("accepted");
    expect(JSON.parse(history[1]!).state).toBe("rejected");
  });

  it("re-parking different text finalizes the still-pending record as 'superseded' — never lost", () => {
    s.parkProposal("first attempt");
    s.parkProposal("second attempt");
    const history = readFileSync(join(dir, "remote", "doc-1.plan.md.proposals.jsonl"), "utf8").trim().split("\n");
    expect(history).toHaveLength(1);
    expect(JSON.parse(history[0]!)).toMatchObject({ state: "superseded", hash: hashBody("first attempt") });
    expect(s.pendingProposal()?.hash).toBe(hashBody("second attempt"));
  });

  it("re-parking IDENTICAL text does not spam the history (same proposal, re-pushed)", () => {
    s.parkProposal("same");
    s.parkProposal("same");
    expect(existsSync(join(dir, "remote", "doc-1.plan.md.proposals.jsonl"))).toBe(false);
    expect(s.pendingProposal()?.hash).toBe(hashBody("same"));
  });

  it("bytes is the UTF-8 byte length, not the UTF-16 code-unit count", () => {
    const text = "café ☕"; // 6 code units; é is 2 UTF-8 bytes, ☕ is 3
    const record = s.parkProposal(text);
    expect(record.bytes).toBe(utf8Bytes(text));
    expect(record.bytes).toBe(9);
    expect(record.bytes).not.toBe(text.length);
  });

  it("a crashed finalization retries without duplicating history (history first, record last, idempotent)", () => {
    s.parkProposal("v1");
    s.resolveProposal("accepted");
    const historyPath = join(dir, "remote", "doc-1.plan.md.proposals.jsonl");
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    // Simulate the crash window: history was appended but the record rewrite never happened —
    // roll the record back to pending_review as if the process died between the two writes.
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(recordPath, JSON.stringify({ ...record, state: "pending_review" }, null, 2));
    s.resolveProposal("accepted"); // the retry
    expect(readFileSync(historyPath, "utf8").trim().split("\n")).toHaveLength(1); // no duplicate line
    expect(s.latestProposal()?.state).toBe("accepted"); // and the record is finalized now
  });

  it("resolveProposal without a pending record is a no-op", () => {
    expect(s.resolveProposal("accepted")).toBeNull();
    expect(s.latestProposal()).toBeNull();
  });

  it("the publish is atomic: a corrupt record reads as absent (no torn write-pair), no .tmp remains", () => {
    s.parkProposal("v1");
    expect(existsSync(join(dir, "remote", "doc-1.plan.md.proposed.json.tmp"))).toBe(false);
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    writeFileSync(recordPath, "{ this is not json"); // external damage
    expect(s.latestProposal()).toBeNull(); // no heuristics — reconciliation from the cloud row heals this
    expect(s.pendingProposal()).toBeNull();
  });

  it("no record reads as no proposal, never a crash", () => {
    expect(s.latestProposal()).toBeNull();
    expect(s.pendingProposal()).toBeNull();
    expect(s.proposedText()).toBeNull();
  });

  it("two proposals with IDENTICAL content and park time keep distinct identities in the history", () => {
    // History idempotency is by unique id, not content: a genuine second proposal that happens to
    // repeat earlier content (even at the same recorded time) must not be swallowed as a
    // crash-retry of the first.
    const at = new Date("2026-08-15T00:00:00.000Z");
    const first = s.parkProposal("same text", at);
    s.resolveProposal("accepted");
    const second = s.parkProposal("same text", at); // terminal record → a NEW proposal is minted
    expect(second.id).not.toBe(first.id);
    s.resolveProposal("rejected");
    const history = readFileSync(join(dir, "remote", "doc-1.plan.md.proposals.jsonl"), "utf8").trim().split("\n");
    expect(history).toHaveLength(2);
    expect(JSON.parse(history[0]!)).toMatchObject({ id: first.id, state: "accepted" });
    expect(JSON.parse(history[1]!)).toMatchObject({ id: second.id, state: "rejected" });
  });

  it("a pending record whose hash/bytes disagree with its own text reads as absent", () => {
    // Valid JSON is not integrity: a corrupted pending record must not feed re-push or row
    // comparison with text it doesn't actually describe. Finalized records tolerate the mismatch
    // (their text is historical convenience, not a recovery input).
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    const base = { id: "p-1", docId: "doc-1", bytes: utf8Bytes("abc"), at: "2026-08-15T00:00:00.000Z", text: "abc" };
    writeFileSync(recordPath, JSON.stringify({ ...base, state: "pending_review", hash: "not-the-text-hash" }));
    expect(s.latestProposal()).toBeNull();
    writeFileSync(recordPath, JSON.stringify({ ...base, state: "pending_review", hash: hashBody("abc"), bytes: 999 }));
    expect(s.latestProposal()).toBeNull();
    writeFileSync(recordPath, JSON.stringify({ ...base, state: "accepted", hash: "not-the-text-hash" }));
    expect(s.latestProposal()?.state).toBe("accepted");
  });

  it("a record failing the full shape check reads as absent — never finalized with bad metadata", () => {
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    const good = { id: "p-1", docId: "doc-1", hash: hashBody("abc"), bytes: utf8Bytes("abc"), at: "2026-08-15T00:00:00.000Z", state: "pending_review", text: "abc" };
    for (const bad of [
      { ...good, docId: "some-other-doc" }, // a record copied from another doc
      { ...good, bytes: "3" }, // non-numeric bytes
      { ...good, at: "not-a-date" }, // unparseable park time
      { ...good, state: "unknown_state" }, // outside the allowed states
      { ...good, id: undefined }, // no identity
      { ...good, text: undefined }, // no embedded text — a torn legacy shape
      { docId: "doc-1", state: "pending_review" }, // partial record
    ]) {
      writeFileSync(recordPath, JSON.stringify(bad));
      expect(s.latestProposal()).toBeNull();
      expect(s.pendingProposal()).toBeNull();
    }
    writeFileSync(recordPath, JSON.stringify(good));
    const { text: _text, ...record } = good;
    expect(s.latestProposal()).toEqual(record);
    expect(s.proposedText()).toBe("abc");
  });
});

describe("isDecidedProposalCorpse — the working copy after a park-then-crash-then-decision", () => {
  it("a working copy equal to a DECIDED record's text is the corpse — restore canonical, don't re-park", () => {
    s.parkProposal("rejected content");
    const rejected = s.resolveProposal("rejected")!;
    expect(isDecidedProposalCorpse(rejected, "rejected content")).toBe(true);
  });

  it("a PENDING record's matching copy is not a corpse — the proposal is live", () => {
    const pending = s.parkProposal("live content");
    expect(isDecidedProposalCorpse(pending, "live content")).toBe(false);
  });

  it("diverged content is real agent work, never a corpse", () => {
    s.parkProposal("decided content");
    const decided = s.resolveProposal("accepted")!;
    expect(isDecidedProposalCorpse(decided, "something the agent typed since")).toBe(false);
    expect(isDecidedProposalCorpse(decided, null)).toBe(false);
    expect(isDecidedProposalCorpse(null, "anything")).toBe(false);
  });
});

describe("row adoption — reconciliation from the cloud's authoritative side", () => {
  it("adopting the cloud row after a finalization recreates a truthful pending record under the row's id", () => {
    s.parkProposal("v1");
    s.resolveProposal("accepted");
    const rec = s.parkProposal("v1", undefined, "row-7"); // what runRemote does when my pending row has no live record
    expect(rec.state).toBe("pending_review");
    expect(rec.id).toBe("row-7");
    expect(s.pendingProposal()?.hash).toBe(hashBody("v1"));
  });

  it("a pending record follows its own row's converged content in place — same id, no supersede", () => {
    const first = s.parkProposal("old text", new Date("2026-08-15T00:00:00.000Z"), "row-7");
    const followed = s.parkProposal("new text", new Date("2026-08-16T00:00:00.000Z"), "row-7");
    expect(followed.id).toBe(first.id);
    expect(followed.hash).toBe(hashBody("new text"));
    expect(followed.at).toBe(first.at); // the ORIGINAL park time — convergence is not a new park
    expect(s.proposedText()).toBe("new text");
    expect(existsSync(join(dir, "remote", "doc-1.plan.md.proposals.jsonl"))).toBe(false); // nothing finalized
  });
});

describe("legacy formats + hydration input (back-compat)", () => {
  it(".synced stays a bare hash string, byte-identical to the legacy writer", () => {
    s.writeWorkFile("content");
    s.recordSynced("content");
    expect(readFileSync(join(dir, "remote", "doc-1.plan.md.synced"), "utf8")).toBe(hashBody("content"));
  });

  it("hydrateInput feeds shouldHydrateWorkFile exactly as the inline code did", () => {
    // No file yet → hydrate.
    expect(shouldHydrateWorkFile(s.hydrateInput())).toBe(true);
    // Fresh sync → hashes match → hydrate (pull the human's edits).
    s.writeWorkFile("synced content");
    s.recordSynced("synced content");
    expect(shouldHydrateWorkFile(s.hydrateInput())).toBe(true);
    // Agent edited since → keep the copy.
    s.writeWorkFile("agent edited this");
    expect(shouldHydrateWorkFile(s.hydrateInput())).toBe(false);
    // Replay pending → never overwrite.
    s.recordSynced("agent edited this");
    s.markReplayPending();
    expect(shouldHydrateWorkFile(s.hydrateInput())).toBe(false);
    s.clearReplayPending();
    expect(shouldHydrateWorkFile(s.hydrateInput())).toBe(true);
  });

  it("proposal files never affect the hydration decision", () => {
    s.writeWorkFile("synced");
    s.recordSynced("synced");
    s.parkProposal("a pending proposal");
    expect(shouldHydrateWorkFile(s.hydrateInput())).toBe(true);
  });
});
