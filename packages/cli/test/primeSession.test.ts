// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan login`'s credential priming (cli.ts → primeSessionOrFail) — the reason the command may
// print `logged_in` at all. It has two routes, and which one runs is the whole design:
//
//   1. the handoff sealed a live ACCESS token ⇒ prove the session non-destructively. The sign-in
//      page seals that token so the CLI has a credential nobody rotates, so spending the refresh
//      token here would re-run the very race the sealed token exists to avoid;
//   2. no usable access token ⇒ force the refresh, the only proof available, so a spent token fails
//      at sign-in rather than an hour later mid-`wait`.
//
// And three outcomes per route, two of which used to be one code path: proved, REFUSED (the
// credential is dead — delete it), and unanswered (a blip or a held refresh lock — KEEP it).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthedSession, CachedSessionCheck, SessionFailure } from "../src/cliAuth";

// vi.mock's factory is hoisted above the file body, so the stubs it installs have to be hoisted too.
const { authedSession, verifyCachedAccessToken, clearAuth, loadAuth } = vi.hoisted(() => ({
  authedSession: vi.fn<(skewS?: number, onFailure?: (r: SessionFailure) => void) => Promise<AuthedSession | null>>(),
  verifyCachedAccessToken: vi.fn<() => Promise<CachedSessionCheck>>(),
  clearAuth: vi.fn(),
  loadAuth: vi.fn<() => { refreshToken: string } | null>(),
}));

// Only the functions primeSessionOrFail acts through are stubbed; the rest of cliAuth stays real.
// currentUser is stubbed too so no sibling import reaches for the network.
vi.mock("../src/cliAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cliAuth")>()),
  authedSession,
  verifyCachedAccessToken,
  clearAuth,
  loadAuth,
  currentUser: vi.fn(async () => null),
}));

import { primeSessionOrFail } from "../src/cli";

/** The skew that forces the refresh path: wider than any token's lifetime, so reuseCached declines
 *  the cache and the single-use token is actually redeemed. */
const FORCE_REFRESH_SKEW_S = 10 * 365 * 24 * 3600;

let stderr: string;
let exits: number[];
beforeEach(() => {
  stderr = "";
  exits = [];
  for (const m of [authedSession, verifyCachedAccessToken, clearAuth, loadAuth]) m.mockReset();
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
/** One failed authedSession attempt reporting `reason`, the way the real one does. */
const fails = (reason: SessionFailure) => async (_skew?: number, onFailure?: (r: SessionFailure) => void) => {
  onFailure?.(reason);
  return null;
};
/** The refresh token rotating is what proves the refresh really happened. */
const rotates = () => {
  let n = 0;
  loadAuth.mockImplementation(() => ({ refreshToken: `rt-${n++}` }));
};
/** A stored token that never changes — what lock contention looks like from the outside. */
const neverRotates = () => loadAuth.mockReturnValue({ refreshToken: "rt-same" });

describe("primeSessionOrFail — route 1: a sealed access token (no rotation spent)", () => {
  it("accepts a validated access token and NEVER touches the refresh token", async () => {
    verifyCachedAccessToken.mockResolvedValue("ok");
    await expect(primeSessionOrFail(0)).resolves.toBeUndefined();
    // The point of the companion sign-in-page change: the single-use token stays unspent, so the
    // CLI never races the browser for it.
    expect(authedSession).not.toHaveBeenCalled();
    expect(clearAuth).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("fails loudly, and deletes, when the server refuses that access token", async () => {
    verifyCachedAccessToken.mockResolvedValue("rejected");
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(clearAuth).toHaveBeenCalledOnce();
    expect(stderr).toMatch(/access token was not accepted/);
    expect(stderr).not.toMatch(/refresh token had already been spent/); // a cause we never observed
    expect(authedSession).not.toHaveBeenCalled(); // no consolation rotation on the way out
  });

  it("keeps the credential when the check is unanswered, and does not escalate to spending the rotation", async () => {
    verifyCachedAccessToken.mockResolvedValue("inconclusive");
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(verifyCachedAccessToken).toHaveBeenCalledTimes(2); // one retry, for the blip
    expect(clearAuth).not.toHaveBeenCalled();
    expect(stderr).toMatch(/could not be verified/);
    expect(stderr).toMatch(/KEPT/);
    // A blip is not evidence the access token is bad, so it must not become a reason to burn the
    // refresh token — that would spend the rotation precisely when the network is unreliable.
    expect(authedSession).not.toHaveBeenCalled();
  });

  it("retries once through a blip and then reports success", async () => {
    verifyCachedAccessToken.mockResolvedValueOnce("inconclusive").mockResolvedValue("ok");
    await expect(primeSessionOrFail(0)).resolves.toBeUndefined();
    expect(authedSession).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });
});

describe("primeSessionOrFail — route 2: no usable access token, so spend the rotation", () => {
  beforeEach(() => {
    verifyCachedAccessToken.mockResolvedValue("absent"); // today's page, or a token near expiry
  });

  it("forces the refresh and returns once the rotation lands", async () => {
    rotates();
    authedSession.mockResolvedValue(ok);
    await expect(primeSessionOrFail(0)).resolves.toBeUndefined();
    // The wide skew IS the mechanism: without it a cached token would satisfy the fast path and the
    // refresh token would never be redeemed at all.
    expect(authedSession).toHaveBeenCalledOnce();
    expect(authedSession).toHaveBeenCalledWith(FORCE_REFRESH_SKEW_S, expect.any(Function));
    expect(exits).toEqual([]);
  });

  it("deletes the credential and names the cause when the server REFUSES the refresh token", async () => {
    neverRotates();
    authedSession.mockImplementation(fails("rejected"));
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(clearAuth).toHaveBeenCalledOnce();
    expect(stderr).toMatch(/refresh token had already been spent/);
    // No second attempt: a verdict does not change, and re-presenting a spent token is exactly the
    // reuse GoTrue punishes by revoking the whole token family.
    expect(authedSession).toHaveBeenCalledOnce();
  });

  it("KEEPS the credential when the refresh never got an answer", async () => {
    neverRotates();
    authedSession.mockImplementation(fails("inconclusive"));
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(clearAuth).not.toHaveBeenCalled();
    expect(stderr).toMatch(/could not be verified/);
    expect(stderr).not.toMatch(/already been spent/);
  });

  it("does NOT accept a cached session served through lock contention as proof of the refresh", async () => {
    // authedSession falls back to any unexpired cached token when it cannot get the refresh lock —
    // on purpose, so a long `wait` survives lock churn. But on THIS path that fallback redeems
    // nothing, so a handoff whose refresh token is spent would otherwise report logged_in having
    // proved nothing at all. The rotation is the proof; an unchanged stored token is not one.
    neverRotates();
    authedSession.mockResolvedValue(ok); // a session, but no rotation behind it
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(authedSession).toHaveBeenCalledTimes(2); // treated as contention ⇒ retried…
    expect(clearAuth).not.toHaveBeenCalled(); // …and unproven, so the credential is kept
    expect(stderr).toMatch(/could not be verified/);
  });

  it("retries once through lock contention, then reports success when the rotation finally lands", async () => {
    authedSession.mockResolvedValue(ok);
    let attempt = 0;
    // First attempt: the stored token is unchanged (the lock was held). Second: it rotated.
    loadAuth.mockImplementation(() => ({ refreshToken: ++attempt <= 2 ? "rt-same" : `rt-new-${attempt}` }));
    await expect(primeSessionOrFail(0)).resolves.toBeUndefined();
    expect(authedSession).toHaveBeenCalledTimes(2);
    expect(clearAuth).not.toHaveBeenCalled();
    expect(exits).toEqual([]);
  });

  it("stops retrying the moment an inconclusive first attempt turns into a refusal", async () => {
    neverRotates();
    authedSession.mockImplementationOnce(fails("inconclusive")).mockImplementation(fails("rejected"));
    await expect(primeSessionOrFail(0)).rejects.toThrow("exit:1");
    expect(authedSession).toHaveBeenCalledTimes(2); // the retry ran, and its verdict is the one that counts
    expect(clearAuth).toHaveBeenCalledOnce();
    expect(stderr).toMatch(/refresh token had already been spent/);
  });
});
