// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan login`'s credential priming (cli.ts → primeSessionOrFail) — the fix's headline
// behaviour, and the reason the command may print `logged_in` at all. Three outcomes have to stay
// distinguishable, because two of them used to be the same code path:
//   proved      — the forced refresh went through, so the credential demonstrably works;
//   REFUSED     — the server looked at the refresh token and rejected it ⇒ delete it, say so;
//   unanswered  — a blip, an outage, or a live `wait` holding the refresh lock ⇒ KEEP it.
// Collapsing the third into the second is what let a dropped connection delete a perfectly good
// credential while blaming a "spent refresh token" that had never been presented to anyone.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedSession, SessionFailure } from "../src/cliAuth";

// vi.mock's factory is hoisted above the file body, so the stubs it installs have to be hoisted too.
const { authedSession, clearAuth } = vi.hoisted(() => ({
  authedSession: vi.fn<(skewS?: number, onFailure?: (r: SessionFailure) => void) => Promise<AuthedSession | null>>(),
  clearAuth: vi.fn(),
}));

// Only the two functions primeSessionOrFail acts through are stubbed; everything else in cliAuth
// stays real. currentUser is stubbed too so no sibling import reaches for the network.
vi.mock("../src/cliAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cliAuth")>()),
  authedSession,
  clearAuth,
  currentUser: vi.fn(async () => null),
}));

import { primeSessionOrFail } from "../src/cli";

/** The skew primeSessionOrFail uses to force the refresh path: wider than any token's lifetime,
 *  so reuseCached declines the cache and the single-use token is actually redeemed. */
const FORCE_REFRESH_SKEW_S = 10 * 365 * 24 * 3600;

let stderr: string;
let exits: number[];
beforeEach(() => {
  stderr = "";
  exits = [];
  authedSession.mockReset();
  clearAuth.mockReset();
  vi.spyOn(process.stderr, "write").mockImplementation(((s: string) => {
    stderr += s;
    return true;
  }) as never);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exits.push(code ?? 0);
    throw new Error(`exit:${code}`); // halt the flow the way the real process.exit does
  }) as never);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A stand-in for a usable session — primeSessionOrFail only checks truthiness. */
const ok = { db: {}, session: {} } as unknown as AuthedSession;
/** One failed attempt that reports `reason` the way the real authedSession does. */
const fails = (reason: SessionFailure) => async (_skew?: number, onFailure?: (r: SessionFailure) => void) => {
  onFailure?.(reason);
  return null;
};

describe("primeSessionOrFail", () => {
  it("forces the refresh path and returns quietly once the credential is proved", async () => {
    authedSession.mockResolvedValue(ok);
    await expect(primeSessionOrFail(0)).resolves.toBeUndefined();
    // The skew is the whole mechanism: without it the cached access token from the handoff would
    // satisfy authedSession's fast path and the refresh token would never be redeemed at all.
    expect(authedSession).toHaveBeenCalledOnce();
    expect(authedSession).toHaveBeenCalledWith(FORCE_REFRESH_SKEW_S, expect.any(Function));
    expect(clearAuth).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("deletes the credential and names the cause when the server REFUSES it", async () => {
    authedSession.mockImplementation(fails("rejected"));
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(clearAuth).toHaveBeenCalledOnce();
    expect(stderr).toMatch(/rejected the credential/);
    expect(exits).toEqual([1]);
    // No second attempt: a verdict does not change, and re-presenting a spent token is exactly
    // the reuse GoTrue punishes by revoking the whole token family.
    expect(authedSession).toHaveBeenCalledOnce();
  });

  it("KEEPS the credential when the check never got an answer, and says so instead of guessing", async () => {
    authedSession.mockImplementation(fails("inconclusive"));
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(clearAuth).not.toHaveBeenCalled(); // a network blip must not cost the user their session
    expect(stderr).toMatch(/could not be verified/);
    expect(stderr).toMatch(/KEPT/);
    expect(stderr).not.toMatch(/already been spent/); // …and must not claim a cause it never saw
    expect(exits).toEqual([1]);
  });

  it("retries once through lock contention, then reports success", async () => {
    // authedSession also returns null when a concurrent `inplan wait` holds the refresh lock.
    // That is contention, not a bad credential, so the one retry has to be able to win.
    authedSession.mockImplementationOnce(fails("inconclusive")).mockResolvedValue(ok);
    await expect(primeSessionOrFail(0)).resolves.toBeUndefined();
    expect(authedSession).toHaveBeenCalledTimes(2);
    expect(clearAuth).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("stops retrying the moment an inconclusive first attempt turns into a refusal", async () => {
    authedSession.mockImplementationOnce(fails("inconclusive")).mockImplementation(fails("rejected"));
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(authedSession).toHaveBeenCalledTimes(2); // the retry ran, and its verdict is the one that counts
    expect(clearAuth).toHaveBeenCalledOnce();
    expect(stderr).toMatch(/rejected the credential/);
  });
});
