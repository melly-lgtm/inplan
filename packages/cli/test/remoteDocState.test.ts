// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RemoteDocState — the durable "did my edit land?" state (#88). The properties pinned here are
// the ones whose absence caused the 2026-08-11 work-deletion: a parked proposal must survive the
// end-of-turn working-copy overwrite, must be auditable turns later, and must resolve to the
// human's actual decision (including partial hunk acceptance), never silently vanish.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogEventType, hashBody, type LogEntry } from "@inplan/core/node";
import { RemoteDocState, needsReparkFromSlot, resolutionFromEvents, utf8Bytes } from "../src/remoteDocState";
import { shouldHydrateWorkFile } from "../src/liveSync";

let dir: string;
let s: RemoteDocState;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "inplan-rds-"));
  s = new RemoteDocState(join(dir, "remote", "doc-1.plan.md"), "doc-1");
  s.ensureDir();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const entry = (type: string, ts: string): LogEntry => ({ seq: 1, ts, actor: "user", type });

describe("resolutionFromEvents", () => {
  const PARK = { at: "2026-08-15T12:00:00.000Z", hash: "hash-P1" };
  const parkEvent = (ts: string, hash?: string): LogEntry => ({ seq: 1, ts, actor: "agent", type: LogEventType.AgentRevisionProposed, ...(hash ? { payload: { bytes: 1, hash } } : {}) });

  it.each([
    ["accepted", LogEventType.RevisionAcceptedAll, "accepted"],
    ["rejected", LogEventType.RevisionRejectedAll, "rejected"],
    ["hunk-accepted → partial", LogEventType.RevisionHunkAccepted, "partially_accepted"],
    ["hunk-rejected → partial", LogEventType.RevisionHunkRejected, "partially_accepted"],
  ])("%s", (_label, type, want) => {
    expect(resolutionFromEvents([entry(type, "2026-08-15T12:05:00.000Z")], PARK)).toBe(want);
  });

  it("no decision event readable → 'decided' (the slot emptied; which way is unknown)", () => {
    expect(resolutionFromEvents([entry(LogEventType.AgentRevised, "2026-08-15T12:05:00.000Z")], PARK)).toBe("decided");
  });

  it("a decision OLDER than the park belongs to a previous proposal and is ignored", () => {
    expect(resolutionFromEvents([entry(LogEventType.RevisionAcceptedAll, "2026-08-15T11:00:00.000Z")], PARK)).toBe("decided");
  });

  it("the newest decision wins when several exist since the park", () => {
    const entries = [
      entry(LogEventType.RevisionRejectedAll, "2026-08-15T12:01:00.000Z"),
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:09:00.000Z"),
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("accepted");
  });

  it("log order beats the clock: a decision after the park EVENT counts even when server timestamps lag the CLI clock", () => {
    // The CLI records the park time from its own clock; Supabase stamps events server-side. With
    // the CLI clock ahead, a fast acceptance can carry a ts EARLIER than the recorded park — the
    // agent_revision_proposed event's position in the log is the boundary that cannot skew.
    const entries = [
      entry(LogEventType.RevisionRejectedAll, "2026-08-15T11:50:00.000Z"), // a PREVIOUS proposal's decision
      parkEvent("2026-08-15T11:58:00.000Z", "hash-P1"), // this park (server ts behind PARK)
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T11:59:00.000Z"), // fast acceptance, ts still < PARK
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("accepted");
  });

  it("a previous proposal's decision BEFORE the park event is never misattributed", () => {
    const entries = [
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:30:00.000Z"), // late server ts, but before the park in log order
      parkEvent("2026-08-15T12:00:02.000Z", "hash-P1"), // ours (within clock slack)
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("decided");
  });

  it("decisions bind to THIS proposal's park event by hash — a later proposal's decision is never claimed", () => {
    // Machine A parks P1 and goes offline; the human rejects P1; machine B parks P2 which is
    // accepted. When A finally resolves P1 it must read P1's rejection, not P2's acceptance.
    const entries = [
      parkEvent("2026-08-15T12:00:02.000Z", "hash-P1"), // ours (within clock slack)
      entry(LogEventType.RevisionRejectedAll, "2026-08-15T12:05:00.000Z"), // P1's decision
      parkEvent("2026-08-15T12:10:00.000Z", "hash-P2"),
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:15:00.000Z"), // P2's decision
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("rejected");
    expect(resolutionFromEvents(entries, { at: "2026-08-15T12:10:00.000Z", hash: "hash-P2" })).toBe("accepted");
  });

  it("a later proposal with no decision for ours → 'decided', never the newer proposal's outcome", () => {
    const entries = [
      parkEvent("2026-08-15T12:00:02.000Z", "hash-P1"), // ours (within clock slack)
      parkEvent("2026-08-15T12:10:00.000Z", "hash-P2"),
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:15:00.000Z"), // P2's decision only
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("decided");
  });

  it("an un-hashed park event (older CLI) still anchors when it plausibly IS this park (within clock slack)", () => {
    const entries = [
      parkEvent("2026-08-15T12:00:03.000Z"), // no hash payload; stamped ~our park time
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:05:00.000Z"),
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("accepted");
  });

  it("a WEAK anchor (our park's event never appended) keeps the timestamp filter — an older proposal's decision is never claimed", () => {
    // Our park's append failed; the last park event in the log is a PREVIOUS proposal's, and its
    // decision sits inside that window. Only a hash-matched anchor earns pure log-order trust;
    // here the decision predates our recorded park time, so it must not finalize our record.
    const entries = [
      parkEvent("2026-08-15T11:00:00.000Z", "hash-OLD"),
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T11:30:00.000Z"), // the OLD proposal's decision
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("decided");
  });

  it("a hash match POSTDATING our park is someone else's identical-text proposal — never our anchor", () => {
    // Identical text is not identity: a newer proposal repeating our content must not donate its
    // decision window to this record. Our own (eligible) park event still anchors correctly.
    const entries = [
      parkEvent("2026-08-15T11:58:00.000Z", "hash-P1"), // ours (within clock slack of PARK.at)
      entry(LogEventType.RevisionRejectedAll, "2026-08-15T11:59:00.000Z"), // OUR decision
      parkEvent("2026-08-15T12:10:00.000Z", "hash-P1"), // another machine's park, SAME text
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:15:00.000Z"), // THEIR decision
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("rejected");
  });

  it("a LATER machine's park never becomes our weak anchor — its decision postdates us but is still not ours", () => {
    // Our park's append failed AND another machine parked after us. The later park event must not
    // anchor our window (its ts postdates our recorded park time), and the window must close at
    // that park even without an anchor — the timestamp filter alone cannot exclude the later
    // decision, because it genuinely postdates our park.
    const entries = [
      parkEvent("2026-08-15T12:10:00.000Z", "hash-P2"), // the other machine's park, after ours (12:00)
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:15:00.000Z"), // P2's decision
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("decided");
  });
});

describe("park / audit / resolve", () => {
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
    expect(s.latestProposal()).toBeNull(); // no heuristics — reconciliation from the cloud slot heals this
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

  it("noteOutcomeMissing marks once, keeps the record pending, and finalize clears the marker", () => {
    s.parkProposal("v1");
    const marked = s.noteOutcomeMissing(new Date("2026-08-15T01:00:00.000Z"));
    expect(marked?.awaitingOutcomeSince).toBe("2026-08-15T01:00:00.000Z");
    expect(s.pendingProposal()?.awaitingOutcomeSince).toBe("2026-08-15T01:00:00.000Z"); // still pending
    expect(s.noteOutcomeMissing()).toBeNull(); // already marked — second sighting is the caller's cue to finalize
    const finalized = s.resolveProposal("decided");
    expect(finalized?.awaitingOutcomeSince).toBeUndefined(); // the grace marker never outlives the decision
    expect(s.latestProposal()?.state).toBe("decided");
  });

  it("re-pushing identical text RESETS a stale awaiting-outcome marker — the slot is live again", () => {
    // Without the reset, a later slot-clear would finalize 'decided' immediately off the old
    // sighting instead of granting the full grace for the decision event to surface.
    const first = s.parkProposal("v1");
    s.noteOutcomeMissing();
    const repushed = s.parkProposal("v1");
    expect(repushed.id).toBe(first.id); // same proposal, re-pushed
    expect(repushed.awaitingOutcomeSince).toBeUndefined();
    expect(s.pendingProposal()?.awaitingOutcomeSince).toBeUndefined();
  });

  it("a pending record whose hash/bytes disagree with its own text reads as absent", () => {
    // Valid JSON is not integrity: a corrupted pending record must not feed re-push or slot
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

describe("needsReparkFromSlot — reconciliation from the cloud's authoritative side", () => {
  const pendingV1 = () => s.parkProposal("v1");

  it("no slot → nothing to reconcile, regardless of local state", () => {
    expect(needsReparkFromSlot(null, null)).toBe(false);
    expect(needsReparkFromSlot(null, undefined)).toBe(false); // transient read failure — retry later
    expect(needsReparkFromSlot(pendingV1(), null)).toBe(false);
  });

  it("a slot with NO local record re-parks (the push landed; the record publish crashed)", () => {
    expect(needsReparkFromSlot(null, "v1")).toBe(true);
  });

  it("a slot with a TERMINAL local record re-parks — even for identical content (a re-park after a finalization)", () => {
    pendingV1();
    const finalized = s.resolveProposal("accepted")!;
    expect(needsReparkFromSlot(finalized, "v1")).toBe(true);
    expect(needsReparkFromSlot(finalized, "v2")).toBe(true);
  });

  it("a slot about DIFFERENT content than the pending record re-parks (the newer park's publish was lost)", () => {
    expect(needsReparkFromSlot(pendingV1(), "v2")).toBe(true);
  });

  it("a healthy pending record matching the slot does nothing", () => {
    expect(needsReparkFromSlot(pendingV1(), "v1")).toBe(false);
  });

  it("re-parking from the slot recreates a truthful pending record", () => {
    pendingV1();
    s.resolveProposal("accepted");
    const rec = s.parkProposal("v1"); // what runRemote does when needsReparkFromSlot says true
    expect(rec.state).toBe("pending_review");
    expect(s.pendingProposal()?.hash).toBe(hashBody("v1"));
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
