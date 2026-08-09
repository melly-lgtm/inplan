// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A real session died mid-`wait` and took the process with it: the access token lasts exactly one
// hour, the refresh was attempted 2 minutes before expiry, it failed, and the poll loop then retried
// it every 200ms until the token expired — replaying a SINGLE-USE refresh token hundreds of times,
// which is how a token family gets revoked. The final failure escaped `void tick()` as an unhandled
// rejection, so Node printed a stack trace where the agent expects one line of JSON.
//
// These pin the four things that changed.

import { describe, expect, it, vi } from "vitest";
import { LIVE_REFRESH_SKEW_S, refreshBackoffMs } from "../src/cliAuth";
import { DEFAULT_ERROR_GRACE_MS, waitForActions } from "../src/wait";
import type { ControlChannel } from "@inplan/core";

describe("refresh backoff", () => {
  it("grows exponentially instead of hammering a single-use token", () => {
    expect(refreshBackoffMs(1)).toBe(1_000);
    expect(refreshBackoffMs(2)).toBe(2_000);
    expect(refreshBackoffMs(3)).toBe(4_000);
    expect(refreshBackoffMs(4)).toBe(8_000);
  });

  it("caps so a long outage still retries, but only about once a minute", () => {
    expect(refreshBackoffMs(20)).toBe(60_000);
    expect(refreshBackoffMs(1000)).toBe(60_000);
  });

  it("never returns a delay shorter than the 200ms poll — the whole point is to be slower", () => {
    for (let f = 1; f <= 50; f++) expect(refreshBackoffMs(f)).toBeGreaterThan(200);
  });

  it("is monotonic, so consecutive failures can only slow down", () => {
    for (let f = 1; f < 30; f++) expect(refreshBackoffMs(f + 1)).toBeGreaterThanOrEqual(refreshBackoffMs(f));
  });

  // The incident: ~120s of budget at a 200ms cadence is ~600 replays of one single-use token.
  it("collapses a 2-minute failure window from hundreds of attempts to a handful", () => {
    const window = 120_000;
    let elapsed = 0;
    let attempts = 0;
    while (elapsed < window) {
      attempts += 1;
      elapsed += refreshBackoffMs(attempts);
    }
    expect(attempts).toBeLessThan(10);
    expect(window / 200).toBeGreaterThan(500); // what it used to be
  });
});

describe("proactive refresh margin", () => {
  it("gives a long wait real retry budget instead of one shot at the cliff", () => {
    expect(LIVE_REFRESH_SKEW_S).toBe(600);
    // Enough room for the backoff to exhaust several attempts before the token actually expires.
    let elapsed = 0;
    let attempts = 0;
    while (elapsed < LIVE_REFRESH_SKEW_S * 1000) {
      attempts += 1;
      elapsed += refreshBackoffMs(attempts);
    }
    expect(attempts).toBeGreaterThanOrEqual(9);
  });
});

/** A channel whose reads reject, to drive the poll loop's failure path. */
function failingChannel(err: Error, failAfter = 0): ControlChannel {
  let reads = 0;
  return {
    append: async () => {},
    readSince: async (cursor: number) => {
      reads += 1;
      if (reads > failAfter) throw err;
      return { entries: [], cursor };
    },
    subscribe: () => () => {},
    getCursor: async () => 0,
    setCursor: async () => {},
    claimLock: async () => {},
    isSuperseded: async () => false,
    presence: async () => true,
  } as unknown as ControlChannel;
}

describe("wait survives a failing poll", () => {
  it("ends with `failed` instead of dying of an unhandled rejection", async () => {
    const err = new Error("inplan: not logged in (or session expired) — run `inplan login`");
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const result = await waitForActions({
        channel: failingChannel(err),
        cursor: 0,
        pollMs: 1,
        errorGraceMs: 0, // give up on the first failure — deterministic, no wall-clock dependence
        watchEditor: false,
      });
      expect(result.failed?.message).toContain("session expired");
      await new Promise((r) => setTimeout(r, 20)); // let any stray rejection surface
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("tolerates a streak shorter than the threshold rather than giving up on a blip", async () => {
    let reads = 0;
    const ch = {
      append: async () => {},
      readSince: async (cursor: number) => {
        reads += 1;
        if (reads <= 2) throw new Error("transient 503");
        return { entries: [{ seq: 1, actor: "user", type: "turn_ended", ts: "" }], cursor: 1 };
      },
      subscribe: () => () => {},
      getCursor: async () => 0,
      setCursor: async () => {},
      claimLock: async () => {},
      isSuperseded: async () => false,
      presence: async () => true,
    } as unknown as ControlChannel;

    const result = await waitForActions({ channel: ch, cursor: 0, pollMs: 1, debounceMs: 1, errorGraceMs: 60_000, watchEditor: false });
    expect(result.failed).toBeUndefined(); // recovered
    expect(result.entries.length).toBe(1);
  });

  it("a recovery resets the streak, so scattered blips never accumulate into a give-up", async () => {
    let reads = 0;
    const ch = {
      append: async () => {},
      readSince: async (cursor: number) => {
        reads += 1;
        if (reads % 2 === 1 && reads < 12) throw new Error("flaky");
        if (reads < 12) return { entries: [], cursor };
        return { entries: [{ seq: 1, actor: "user", type: "turn_ended", ts: "" }], cursor: 1 };
      },
      subscribe: () => () => {},
      getCursor: async () => 0,
      setCursor: async () => {},
      claimLock: async () => {},
      isSuperseded: async () => false,
      presence: async () => true,
    } as unknown as ControlChannel;

    // A fake clock makes the reset observable: without it, the run that starts at t=0 would exceed
    // the 150ms grace long before the channel recovers.
    let t = 0;
    const result = await waitForActions({ channel: ch, cursor: 0, pollMs: 1, debounceMs: 1, errorGraceMs: 150, now: () => (t += 100), watchEditor: false });
    expect(result.failed).toBeUndefined();
  });
});

// The backoff and the give-up budget are two of this PR's own fixes, and they interact: a refresh
// cooldown of up to 60s means EVERY poll in that window fails for one underlying reason. A tick-count
// budget would read that single cooldown as hundreds of independent failures and abandon a wait
// seconds into a backoff designed to outlast it — so the budget is expressed in time.
describe("give-up budget vs refresh backoff", () => {
  it("survives a full 60s refresh cooldown on the REAL default", () => {
    // Asserted against wait.ts's exported constant, not a copy: a local literal would keep passing
    // while the shipped default drifted, which is the opposite of what this test is for.
    expect(DEFAULT_ERROR_GRACE_MS).toBeGreaterThan(refreshBackoffMs(1000)); // one max-length cooldown…
    expect(DEFAULT_ERROR_GRACE_MS / refreshBackoffMs(1000)).toBeGreaterThanOrEqual(5); // …and several more
  });

  it("applies that default when the caller passes no budget", async () => {
    let t = 0;
    const ch = {
      append: async () => {},
      readSince: async () => { throw new Error("cooling off"); },
      subscribe: () => () => {},
      getCursor: async () => 0,
      setCursor: async () => {},
      claimLock: async () => {},
      isSuperseded: async () => false,
      presence: async () => true,
    } as unknown as ControlChannel;
    // No errorGraceMs: the shipped default must carry it past a full cooldown without giving up.
    const result = await Promise.race([
      waitForActions({ channel: ch, cursor: 0, pollMs: 1, now: () => (t += 1_000), watchEditor: false }),
      new Promise((r) => setTimeout(() => r("still waiting"), 250)),
    ]);
    expect(result).toBe("still waiting");
  });

  it("does not give up early just because the poll cadence is fast", async () => {
    // 200ms polls over a 60s cooldown = ~300 failing ticks. Time-based, that is one failure run.
    let t = 0;
    const ch = {
      append: async () => {},
      readSince: async () => { throw new Error("session refresh cooling off"); },
      subscribe: () => () => {},
      getCursor: async () => 0,
      setCursor: async () => {},
      claimLock: async () => {},
      isSuperseded: async () => false,
      presence: async () => true,
    } as unknown as ControlChannel;
    // 300 ticks of 200ms advance 60s of fake time — under the 5-minute grace, so it must NOT give up.
    const result = await Promise.race([
      waitForActions({ channel: ch, cursor: 0, pollMs: 1, errorGraceMs: 5 * 60_000, now: () => (t += 200), watchEditor: false }),
      new Promise((r) => setTimeout(() => r("still waiting"), 300)),
    ]);
    expect(result).toBe("still waiting");
  });
});
