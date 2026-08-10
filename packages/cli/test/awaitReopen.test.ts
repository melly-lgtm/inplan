// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The reopen grace (wait.ts awaitReopen): a `window_closed` session-close is routinely a page
// RELOAD — the editor logs the close on teardown and is back seconds later, appending no events.
// These tests pin the resumption signals (a new user action; the presence heartbeat) and the
// silence semantics (grace expiry ⇒ the human really left), plus tolerance of transient failures.

import { describe, expect, it, vi } from "vitest";
import { LogEventType } from "@inplan/core/node";
import { awaitReopen } from "../src/wait";

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

type Chan = { readSince: (c: number) => Promise<{ entries: unknown[]; cursor: number }>; presence: () => Promise<boolean>; isSuperseded: (t: string) => Promise<boolean> };
const chan = (over: Partial<Chan>): never =>
  ({ readSince: async () => ({ entries: [], cursor: 0 }), presence: async () => false, isSuperseded: async () => false, ...over }) as never;

describe("awaitReopen", () => {
  it("resumes on a NEW user-authored entry past the cursor", async () => {
    const c = clock();
    const ch = chan({ readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.CommentCreated }], cursor: 9 }) });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 60_000 })).resolves.toBe("reopened");
  });

  it("resumes on the editor presence heartbeat — a silent reload appends no events", async () => {
    const c = clock();
    let polls = 0;
    const ch = chan({ presence: async () => ++polls >= 3 }); // page back after a couple of polls
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 1000 })).resolves.toBe("reopened");
    expect(polls).toBe(3);
  });

  it("a trailing SessionClosed alone is NOT resumption", async () => {
    const c = clock();
    const ch = chan({ readSince: async () => ({ entries: [{ seq: 9, actor: "user", type: LogEventType.SessionClosed }], cursor: 9 }) });
    await expect(awaitReopen(ch, 8, { ...c, graceMs: 10_000, pollMs: 1000 })).resolves.toBe("expired");
  });

  it("gives up after a silent grace — the human really left", async () => {
    const c = clock();
    const reads = vi.fn(async () => ({ entries: [], cursor: 0 }));
    const ch = chan({ readSince: reads });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 10_000, pollMs: 2000 })).resolves.toBe("expired");
    expect(reads.mock.calls.length).toBeGreaterThanOrEqual(4); // it genuinely kept watching
  });

  it("steps down the moment a newer waiter supersedes it — grace must not steal the lock back", async () => {
    const c = clock();
    let checks = 0;
    const ch = chan({ isSuperseded: async () => ++checks >= 2 });
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 1000, token: "tok" })).resolves.toBe("superseded");
  });

  it("a stalled channel probe cannot park the watch past the grace (bounded per-probe)", async () => {
    const c = clock();
    const never = new Promise<never>(() => {});
    // The bounded race uses real timers, so give the probe a real (tiny) budget and real time.
    const ch = chan({ readSince: () => never as never });
    const start = Date.now();
    const r = await awaitReopen(ch, 0, { graceMs: 300, pollMs: 50, probeTimeoutMs: 50 });
    expect(r).toBe("expired");
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
    await expect(awaitReopen(ch, 0, { ...c, graceMs: 60_000, pollMs: 1000 })).resolves.toBe("reopened");
  });
});
