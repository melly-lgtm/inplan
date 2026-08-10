// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reopen grace (wait.ts awaitReopen): a `window_closed` session-close is routinely a page
// RELOAD — the editor logs the close on teardown and is back seconds later, appending no events.
// These tests pin the resumption signals (a new user action; the presence heartbeat) and the
// silence semantics (grace expiry ⇒ the human really left), plus tolerance of transient failures.

import { describe, expect, it, vi } from "vitest";
import { LogEventType } from "@inplan/core/node";
import { awaitReopen, lockForCycle } from "../src/wait";

function clock(t0 = 0) {
  let t = t0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

type Chan = { readSince: (c: number) => Promise<{ entries: unknown[]; cursor: number }>; presence: (sinceMs?: number) => Promise<boolean>; isSuperseded: (t: string) => Promise<boolean> };
const chan = (over: Partial<Chan>): never =>
  ({ readSince: async () => ({ entries: [], cursor: 0 }), presence: async () => false, isSuperseded: async () => false, ...over }) as never;

describe("awaitReopen", () => {
  it("resumes on a NEW user-authored entry past the cursor", async () => {
    const c = clock();
    const ch = chan({ readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.CommentCreated }], cursor: 9 }) });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 60_000 })).resolves.toMatchObject({ kind: "reopened" });
  });

  it("resumes on the editor presence heartbeat — a silent reload appends no events", async () => {
    const c = clock();
    let polls = 0;
    const ch = chan({ presence: async () => ++polls >= 3 }); // page back after a couple of polls
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "reopened" });
    expect(polls).toBe(3);
  });

  it("ignores a pre-close heartbeat still inside its TTL — freshness-gated, not mere presence", async () => {
    const c = clock(1_000_000);
    // The just-closed editor's heartbeat lingers for the presence TTL. Written 5s BEFORE the watch
    // began (< graceStart), it must NOT read as a reopen — otherwise a real close resumes a dead
    // session until the stale row expires, then ends the wait, defeating the grace.
    const ch = chan({ presence: async (sinceMs) => 995_000 > (sinceMs ?? 0) });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 10_000, pollMs: 2000 })).resolves.toMatchObject({ kind: "expired" });
  });

  it("resumes only once a heartbeat is written AFTER the watch begins (a genuine return)", async () => {
    const c = clock(1_000_000);
    // The mock's answer depends on the ARGUMENT it received, not on the clock alone: it reports a
    // heartbeat only when told to count ones newer than a time at/after the grace start. Deriving it
    // from `c.now()` instead would return true even if `awaitReopen` stopped passing `graceStart`
    // (sinceMs would default to 0 and still satisfy it) — the test would then pass with the very
    // gate it claims to cover removed.
    const ch = chan({ presence: async (sinceMs) => (sinceMs ?? 0) >= 1_000_000 && c.now() >= 1_004_000 });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 2000 })).resolves.toMatchObject({ kind: "reopened" });
  });

  it("an explicit `completed` during the grace ends it NOW, not after the full window", async () => {
    // The build handoff. Before this it was ignored for the whole grace and then surfaced as
    // `window_closed` — the deliberate action both delayed by minutes and mislabelled.
    const c = clock();
    const ch = chan({
      readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.SessionClosed, payload: { reason: "completed" } }], cursor: 9 }),
    });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 600_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "completed" });
  });

  it("a NEWER window_closed during the grace is just another reload, not an end", async () => {
    const c = clock();
    const ch = chan({
      readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.SessionClosed, payload: { reason: "window_closed" } }], cursor: 9 }),
    });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 10_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "expired" });
  });

  it("a trailing SessionClosed alone is NOT resumption", async () => {
    const c = clock();
    const ch = chan({ readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.SessionClosed }], cursor: 9 }) });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 10_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "expired" });
  });

  it("gives up after a silent grace — the human really left", async () => {
    const c = clock();
    const reads = vi.fn(async () => ({ entries: [], cursor: 0 }));
    const ch = chan({ readSince: reads });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 10_000, pollMs: 2000 })).resolves.toMatchObject({ kind: "expired" });
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(4); // it genuinely kept watching
  });

  it("steps down the moment a newer waiter supersedes it — grace must not steal the lock back", async () => {
    const c = clock();
    let checks = 0;
    const ch = chan({ isSuperseded: async () => ++checks >= 2 });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 1000, token: "tok" })).resolves.toMatchObject({ kind: "superseded" });
  });

  it("a stalled channel probe cannot park the watch past the grace (bounded per-probe)", async () => {
    const c = clock();
    const never = new Promise<never>(() => {});
    // The bounded race uses real timers, so give the probe a real (tiny) budget and real time.
    const ch = chan({ readSince: () => never as never });
    const start = Date.now();
    const r = await awaitReopen(ch, 0, { graceMs: 300, pollMs: 50, probeTimeoutMs: 50 });
    expect(r).toMatchObject({ kind: "expired" });
    expect(Date.now() - start).toBeLessThan(5_000); // returned promptly despite the forever-pending read
  });

  it("tolerates transient failures and still catches a later return", async () => {
    const c = clock();
    let n = 0;
    const ch = chan({
      readSince: async () => {
        if (++n <= 2) throw new Error("blip");
        return { entries: [], cursor: 0 };
      },
      presence: async () => n >= 4,
    });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "reopened" });
  });
});

// The reopen grace promises that a stale waiter cannot outlive its replacement and steal the lock
// back. That promise lives entirely in whether a RESUMED cycle re-claims.
describe("lockForCycle", () => {
  it("a fresh cycle mints a token and claims", () => {
    expect(lockForCycle(undefined, () => "pid-1")).toEqual({ token: "pid-1", claim: true });
  });

  it("a resumed cycle keeps its token and does NOT claim", () => {
    // Claiming here would overwrite whatever a newer waiter wrote during the grace.
    expect(lockForCycle("original-token", () => "pid-2")).toEqual({ token: "original-token", claim: false });
  });

  it("never mints a replacement token on resume, even if asked", () => {
    let minted = 0;
    lockForCycle("original-token", () => `pid-${++minted}`);
    expect(minted).toBe(0); // the mint function is not even called
  });

  it("the resumed token is the ORIGINAL, so isSuperseded can detect the loss", () => {
    // Keeping the old token is what makes losing detectable: the poll loop asks
    // isSuperseded(token), which is only meaningful for the token this waiter actually held.
    const { token } = lockForCycle("t-original", () => "t-new");
    expect(token).toBe("t-original");
  });
});

// One catch around all three probes meant a timing-out lock or log read skipped the healthy ones for
// that iteration. During a read outage the presence heartbeat is the ONLY signal that a human came
// back, so swallowing it there defeats the grace exactly when it is needed.
describe("probe failures are isolated", () => {
  it("a failing lock probe does not stop presence from proving the return", async () => {
    const c = clock();
    const ch = chan({
      isSuperseded: async () => {
        throw new Error("locks table unreachable");
      },
      presence: async () => true,
    });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 10_000, pollMs: 500, token: "t" })).resolves.toMatchObject({ kind: "reopened" });
  });

  it("a failing log read does not stop presence from proving the return", async () => {
    const c = clock();
    const ch = chan({
      readSince: async () => {
        throw new Error("events read timed out");
      },
      presence: async () => true,
    });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 10_000, pollMs: 500 })).resolves.toMatchObject({ kind: "reopened" });
  });

  it("a failing presence probe does not stop a user entry from proving the return", async () => {
    const c = clock();
    const ch = chan({
      readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.TurnEnded }], cursor: 9 }),
      presence: async () => {
        throw new Error("presence unreadable");
      },
    });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 10_000, pollMs: 500 })).resolves.toMatchObject({ kind: "reopened" });
  });

  it("all three failing still expires cleanly rather than hanging", async () => {
    const c = clock();
    const boom = async () => {
      throw new Error("outage");
    };
    const ch = chan({ isSuperseded: boom, readSince: boom, presence: boom });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 5_000, pollMs: 500, token: "t" })).resolves.toMatchObject({ kind: "expired" });
  });
});

describe("the grace read reports what actually happened", () => {
  it("carries the reason the editor logged, not a fixed \"completed\"", async () => {
    // awaitReopen treats ANY explicit non-window_closed reason as terminal, so hard-coding the
    // report would relabel some other close as the build handoff — and the agent switches to build
    // mode on that reason.
    const c = clock();
    const ch = chan({
      readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.SessionClosed, payload: { reason: "archived" } }], cursor: 9 }),
    });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 60_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "completed", reason: "archived" });
  });

  it("still reports `completed` for the build handoff itself", async () => {
    const c = clock();
    const ch = chan({
      readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.SessionClosed, payload: { reason: "completed" } }], cursor: 9 }),
    });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 60_000, pollMs: 1000 })).resolves.toMatchObject({ kind: "completed", reason: "completed" });
  });

  it("reads only the DELTA each poll, but reports every entry the grace saw", async () => {
    const c = clock();
    const asked: number[] = [];
    let poll = 0;
    const ch = chan({
      readSince: async (from: number) => {
        asked.push(from);
        poll += 1;
        // Agent-authored: does NOT prove a reopen, so the loop continues to a second poll.
        if (poll === 1) return { entries: [{ seq: 9, actor: "agent", type: LogEventType.AgentRevised }], cursor: 9 };
        return { entries: [{ seq: 10, actor: "user", type: LogEventType.SessionClosed, payload: { reason: "completed" } }], cursor: 10 };
      },
    });
    const r = await awaitReopen(ch, 8, { ...c, graceMs: 60_000, pollMs: 1000 });
    // The cursor advanced rather than re-reading from 8 forever…
    expect(asked).toEqual([8, 9]);
    // …and the report still contains BOTH polls' entries, not just the last delta.
    expect(r).toMatchObject({ kind: "completed", cursor: 10 });
    expect((r as { entries: { seq: number }[] }).entries.map((e) => e.seq)).toEqual([9, 10]);
  });
});
