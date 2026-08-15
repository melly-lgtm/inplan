// SPDX-License-Identifier: AGPL-3.0-or-later
//
// RemoteDocState — the durable "did my edit land?" state (#88). The properties pinned here are
// the ones whose absence caused the 2026-08-11 work-deletion: a parked proposal must survive the
// end-of-turn working-copy overwrite, must be auditable turns later, and must resolve to the
// human's actual decision (including partial hunk acceptance), never silently vanish.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LogEventType, hashBody, type LogEntry } from "@inplan/core/node";
import { RemoteDocState, resolutionFromEvents, utf8Bytes } from "../src/remoteDocState";
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
  const PARK = "2026-08-15T12:00:00.000Z";
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
      entry(LogEventType.AgentRevisionProposed, "2026-08-15T11:58:00.000Z"), // this park (server ts behind PARK)
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T11:59:00.000Z"), // fast acceptance, ts still < PARK
    ];
    expect(resolutionFromEvents(entries, PARK)).toBe("accepted");
  });

  it("a previous proposal's decision BEFORE the park event is never misattributed", () => {
    const entries = [
      entry(LogEventType.RevisionAcceptedAll, "2026-08-15T12:30:00.000Z"), // late server ts, but before the park in log order
      entry(LogEventType.AgentRevisionProposed, "2026-08-15T12:31:00.000Z"),
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

  it("resolveProposal without a pending record is a no-op", () => {
    expect(s.resolveProposal("accepted")).toBeNull();
    expect(s.latestProposal()).toBeNull();
  });

  it("a corrupt record file reads as no record, never a crash", () => {
    s.parkProposal("v1");
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    writeFileSync(recordPath, "{ this is not json"); // exercises the parse-failure branch
    expect(s.latestProposal()).toBeNull();
    rmSync(recordPath); // and plain absence
    expect(s.latestProposal()).toBeNull();
  });

  it("a record failing the full shape check reads as absent — never finalized with bad metadata", () => {
    const recordPath = join(dir, "remote", "doc-1.plan.md.proposed.json");
    const good = { docId: "doc-1", hash: "h", bytes: 3, at: "2026-08-15T00:00:00.000Z", state: "pending_review" };
    for (const bad of [
      { ...good, docId: "some-other-doc" }, // a record copied from another doc
      { ...good, bytes: "3" }, // non-numeric bytes
      { ...good, at: "not-a-date" }, // unparseable park time
      { ...good, state: "unknown_state" }, // outside the allowed states
      { docId: "doc-1", state: "pending_review" }, // partial record
    ]) {
      writeFileSync(recordPath, JSON.stringify(bad));
      expect(s.latestProposal()).toBeNull();
      expect(s.pendingProposal()).toBeNull();
    }
    writeFileSync(recordPath, JSON.stringify(good));
    expect(s.latestProposal()).toEqual(good);
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
