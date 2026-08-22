// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers the authenticated-session paths of cliAuth (refresh, rotation persist,
// remoteBackend wiring) with a mocked supabase-js — no network, no real creds.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let refreshResult: { data: { session: unknown }; error: unknown } = { data: { session: null }, error: null };
const refreshSession = vi.fn(async () => refreshResult);
// setSession is the local (no-network) reuse of a still-valid access token: echo it back as a session.
const setSession = vi.fn(async ({ access_token, refresh_token }: { access_token: string; refresh_token: string }) => ({
  data: { session: { access_token, refresh_token, user: { id: "user-1", email: "cached@x.io" } } },
  error: null,
}));

// getUser is the ONE authenticated round-trip the non-destructive check makes: setSession is a local
// decode, so only this can tell us the server still accepts the token.
let getUserResult: { data: { user: unknown }; error: unknown } = { data: { user: { id: "user-1" } }, error: null };
const getUser = vi.fn(async (_jwt?: string) => getUserResult);

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { refreshSession, setSession, getUser } })),
}));
vi.mock("@inplan/backend-supabase", () => ({
  // A minimal channel: getCursor/readSince are stubbed so a delegating call has something to hit.
  // Tests assert delegation by side effect (refresh/setSession call counts), not the return values.
  SupabaseControlChannel: class {
    constructor(public db: unknown, public docId: string, public consumer: string) {}
    async getCursor() { return 0; }
    async readSince(cursor: number) { return { entries: [], cursor }; }
  },
  SupabaseDocumentStore: class { constructor(public db: unknown, public docId: string) {} },
}));

import { authedSession, currentUser, liveRemoteBackend, remoteBackend, saveAuth, authPath, verifyCachedAccessToken, withAuthLock } from "../src/cliAuth";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-auth-"));
  process.env.INPLAN_HOME = home;
  refreshResult = { data: { session: null }, error: null }; // reset so tests don't inherit a prior one's value
  getUserResult = { data: { user: { id: "user-1" } }, error: null };
  refreshSession.mockClear();
  setSession.mockClear();
  getUser.mockClear();
});
afterEach(() => {
  delete process.env.INPLAN_HOME;
  vi.clearAllMocks();
});

const seed = () => saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt-old", email: "old@x.io" });
const session = (over: Record<string, unknown> = {}) => ({
  refresh_token: "rt-new",
  access_token: "jwt-123",
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: { id: "user-1", email: "new@x.io" },
  ...over,
});

describe("authedSession", () => {
  it("returns null when not logged in", async () => {
    expect(await authedSession()).toBeNull();
  });

  it("returns null when the refresh fails", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "expired" } };
    expect(await authedSession()).toBeNull();
  });

  it("refreshes, persisting the rotated refresh token + cached access token + email", async () => {
    seed();
    refreshResult = { data: { session: session() }, error: null };
    const s = await authedSession();
    expect(s?.session.access_token).toBe("jwt-123");
    const stored = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(stored.refreshToken).toBe("rt-new");
    expect(stored.email).toBe("new@x.io");
    expect(stored.accessToken).toBe("jwt-123"); // cached so the next call can reuse without a refresh
    expect(typeof stored.expiresAt).toBe("number");
  });

  it("reuses a valid cached access token without refreshing or rewriting (concurrency-safe fast path)", async () => {
    saveAuth({
      url: "https://x.supabase.co",
      anonKey: "anon",
      refreshToken: "rt",
      email: "e@x.io",
      accessToken: "cached-jwt",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    const before = readFileSync(authPath(), "utf8");
    const s = await authedSession();
    expect(s?.session.access_token).toBe("cached-jwt"); // used the cached token…
    expect(refreshSession).not.toHaveBeenCalled(); // …with NO refresh ⇒ no refresh-token rotation…
    expect(readFileSync(authPath(), "utf8")).toBe(before); // …and no rewrite of auth.json
  });

  it("a skew wider than the token's life forces a refresh, so login can prove the refresh token works", async () => {
    // What `primeSessionOrFail` relies on: with a valid cached access token the fast path would
    // return a session without ever redeeming the refresh token, so a token the sign-in page had
    // already spent would pass login and only fail an hour later, mid-`wait`.
    saveAuth({
      url: "https://x.supabase.co",
      anonKey: "anon",
      refreshToken: "rt",
      email: "e@x.io",
      accessToken: "cached-jwt",
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    });
    refreshResult = { data: { session: session() }, error: null };
    const s = await authedSession(10 * 365 * 24 * 3600);
    expect(refreshSession).toHaveBeenCalled(); // the cached token was declined ⇒ refresh ran
    expect(s?.session.access_token).toBe("jwt-123"); // and its result is what we got back
  });

  it("falls through to refresh when the cached access token is expired", async () => {
    saveAuth({
      url: "https://x.supabase.co",
      anonKey: "anon",
      refreshToken: "rt",
      accessToken: "old-jwt",
      expiresAt: Math.floor(Date.now() / 1000) - 10, // already expired
    });
    refreshResult = { data: { session: session() }, error: null };
    await authedSession();
    expect(refreshSession).toHaveBeenCalled();
  });
});

// authedSession returns a bare null for every kind of failure, which is all its usual callers need
// ("can I act as this user?"). Login's credential priming is the exception: it decides whether to
// DELETE the credential, and that is only defensible when the server actually refused it. These
// cases pin which failures count as a verdict and which are merely an absence of one.
describe("authedSession failure reasons", () => {
  /** Run authedSession and collect whatever reason it reported. */
  const reasonOf = async (skewS?: number): Promise<Array<"rejected" | "inconclusive">> => {
    const seen: Array<"rejected" | "inconclusive"> = [];
    await authedSession(skewS, (r) => seen.push(r));
    return seen;
  };

  it("a 400 from GoTrue is a verdict on the credential ⇒ rejected", async () => {
    seed();
    // What a spent handoff token actually looks like: HTTP 400 refresh_token_already_used.
    refreshResult = { data: { session: null }, error: { message: "Invalid Refresh Token: Already Used", status: 400 } };
    expect(await reasonOf()).toEqual(["rejected"]);
  });

  it("401/403 are the same class of refusal ⇒ rejected", async () => {
    for (const status of [401, 403]) {
      seed();
      refreshResult = { data: { session: null }, error: { message: "nope", status } };
      expect(await reasonOf()).toEqual(["rejected"]);
    }
  });

  it("a 5xx never looked at the credential ⇒ inconclusive", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "bad gateway", status: 502 } };
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("a transport failure (supabase-js reports status 0) ⇒ inconclusive", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "fetch failed", status: 0 } };
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("an error with no status at all ⇒ inconclusive (unrecognised means unproven)", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "something went wrong" } };
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("429 is 'try later', NOT a refusal ⇒ inconclusive", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "rate limited", status: 429 } };
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("a response with no rotated token ⇒ inconclusive (we declined it; nobody refused us)", async () => {
    // The stderr line on this path says it is KEEPING the stored token — so the reason must not be
    // one that makes a caller delete it a moment later.
    seed();
    refreshResult = { data: { session: session({ refresh_token: undefined }) }, error: null };
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("an empty session with no error ⇒ inconclusive", async () => {
    seed();
    refreshResult = { data: { session: null }, error: null };
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("no credentials at all ⇒ inconclusive (there was nothing to refuse)", async () => {
    expect(await reasonOf()).toEqual(["inconclusive"]);
  });

  it("stays silent on success, including the cached fast path", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt", accessToken: "cached-jwt", expiresAt: Math.floor(Date.now() / 1000) + 3600 });
    expect(await reasonOf()).toEqual([]); // fast path
    refreshResult = { data: { session: session() }, error: null };
    expect(await reasonOf(10 * 365 * 24 * 3600)).toEqual([]); // forced refresh, succeeded
  });
});

// A `rejected` verdict spans 400/401/403 — a spent refresh token, but equally a bad anon key or a
// revoked user. The CAUSE is what lets login explain itself without asserting more than it knows,
// so it must be reported only when GoTrue actually named it.
describe("authedSession rejection causes", () => {
  const gradeOf = async (): Promise<Array<[string, string | undefined]>> => {
    const seen: Array<[string, string | undefined]> = [];
    await authedSession(undefined, (reason, cause) => seen.push([reason, cause]));
    return seen;
  };

  it("names the spent-token case from GoTrue's structured code", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { code: "refresh_token_already_used", message: "whatever", status: 400 } };
    expect(await gradeOf()).toEqual([["rejected", "refresh-token-spent"]]);
  });

  it("also names it from the message alone, for deployments predating `error_code`", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "Invalid Refresh Token: Already Used", status: 400 } };
    expect(await gradeOf()).toEqual([["rejected", "refresh-token-spent"]]);
  });

  it("does NOT name it for other refusals — a 401 from a bad anon key is not a spent token", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "Invalid API key", status: 401 } };
    expect(await gradeOf()).toEqual([["rejected", "unspecified"]]);
  });

  it("does NOT name it for a generic 400 either", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { code: "invalid_grant", message: "Invalid Refresh Token", status: 400 } };
    expect(await gradeOf()).toEqual([["rejected", "unspecified"]]);
  });

  it("reports no cause worth acting on when the failure was merely unanswered", async () => {
    seed();
    refreshResult = { data: { session: null }, error: { message: "fetch failed", status: 0 } };
    expect(await gradeOf()).toEqual([["inconclusive", "unspecified"]]);
  });
});

// The sign-in page seals its live access token so the CLI has a credential nobody rotates. Proving
// that credential must therefore NOT spend the single-use refresh token — otherwise the CLI re-runs
// the exact race the sealed token exists to avoid, and the page's half of the fix buys nothing.
describe("verifyCachedAccessToken", () => {
  const live = () => Math.floor(Date.now() / 1000) + 3600;
  const withToken = (expiresAt = live()) =>
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt", accessToken: "cached-jwt", expiresAt });

  it("confirms a live token against the server WITHOUT refreshing — the whole point", async () => {
    withToken();
    const before = readFileSync(authPath(), "utf8");
    expect(await verifyCachedAccessToken()).toBe("ok");
    expect(getUser).toHaveBeenCalledWith("cached-jwt"); // a real round-trip, not a local decode
    expect(refreshSession).not.toHaveBeenCalled(); // …and the single-use token is still unspent
    expect(readFileSync(authPath(), "utf8")).toBe(before); // no rotation ⇒ nothing rewritten
  });

  it("a 401 on the identity check is a refusal ⇒ rejected", async () => {
    withToken();
    getUserResult = { data: { user: null }, error: { message: "invalid JWT", status: 401 } };
    expect(await verifyCachedAccessToken()).toBe("rejected");
    expect(refreshSession).not.toHaveBeenCalled(); // still no rotation, even on the failure path
  });

  it("a 5xx or a dropped connection ⇒ inconclusive, never a refusal", async () => {
    withToken();
    getUserResult = { data: { user: null }, error: { message: "bad gateway", status: 502 } };
    expect(await verifyCachedAccessToken()).toBe("inconclusive");
    getUserResult = { data: { user: null }, error: { message: "fetch failed", status: 0 } };
    expect(await verifyCachedAccessToken()).toBe("inconclusive");
  });

  it("no user and no error ⇒ inconclusive (nothing was actually established)", async () => {
    withToken();
    getUserResult = { data: { user: null }, error: null };
    expect(await verifyCachedAccessToken()).toBe("inconclusive");
  });

  it("reports `absent` when there is no token worth checking", async () => {
    expect(await verifyCachedAccessToken()).toBe("absent"); // logged out entirely
    seed(); // credentials, but the handoff sealed no access token (today's page)
    expect(await verifyCachedAccessToken()).toBe("absent");
    withToken(Math.floor(Date.now() / 1000) - 10); // expired
    expect(await verifyCachedAccessToken()).toBe("absent");
    withToken(Math.floor(Date.now() / 1000) + 30); // inside ACCESS_SKEW_S: the next command would refresh it anyway
    expect(await verifyCachedAccessToken()).toBe("absent");
    expect(getUser).not.toHaveBeenCalled(); // nothing to check ⇒ no round-trip at all
  });
});

describe("currentUser", () => {
  it("maps the session to {id,email}, or null when logged out", async () => {
    expect(await currentUser()).toBeNull();
    seed();
    refreshResult = { data: { session: session() }, error: null };
    expect(await currentUser()).toEqual({ id: "user-1", email: "new@x.io" });
  });
});

describe("remoteBackend", () => {
  it("returns null when logged out", async () => {
    expect(await remoteBackend("doc-1")).toBeNull();
  });
  it("binds a channel + store + token to the doc when authed", async () => {
    seed();
    refreshResult = { data: { session: session() }, error: null };
    const b = await remoteBackend("doc-1", "cli-agent");
    expect(b?.token).toBe("jwt-123");
    expect((b?.channel as unknown as { docId: string }).docId).toBe("doc-1");
    expect((b?.store as unknown as { docId: string }).docId).toBe("doc-1");
  });
});

describe("liveRemoteBackend", () => {
  const now = () => Math.floor(Date.now() / 1000);

  it("mints once then reuses the client while the token stays valid (no re-refresh)", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt", email: "e@x.io", accessToken: "cached-jwt", expiresAt: now() + 3600 });
    const live = liveRemoteBackend("doc-1");
    await live.channel.getCursor(); // first call mints (fast path: setSession, no refresh)
    await live.channel.getCursor(); // token still valid ⇒ reuse the cached inner, no new mint
    expect(refreshSession).not.toHaveBeenCalled(); // never rotates the single-use token
    expect(setSession).toHaveBeenCalledTimes(1); // minted exactly once
    expect(live.tokenNow()).toBe("cached-jwt");
  });

  it("re-mints through the locked refresh path when the cached token is within the expiry skew", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt-old", email: "e@x.io", accessToken: "old", expiresAt: now() + 60 }); // < ACCESS_SKEW_S ⇒ stale
    refreshResult = { data: { session: session({ access_token: "jwt-123", expires_at: now() + 3600 }) }, error: null };
    const live = liveRemoteBackend("doc-1");
    await live.channel.getCursor();
    expect(refreshSession).toHaveBeenCalledTimes(1); // expiring ⇒ coordinated refresh
    await live.channel.getCursor();
    expect(refreshSession).toHaveBeenCalledTimes(1); // freshly minted token is valid ⇒ reused, not re-refreshed
    expect(live.tokenNow()).toBe("jwt-123");
  });

  it("coalesces concurrent re-mints into a single refresh (no rotation storm)", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt-old", email: "e@x.io", accessToken: "old", expiresAt: now() + 60 }); // stale ⇒ needs a re-mint
    refreshResult = { data: { session: session({ access_token: "jwt-123", expires_at: now() + 3600 }) }, error: null };
    const live = liveRemoteBackend("doc-1");
    // Fire several channel calls before the first re-mint resolves: they must share ONE refresh, not
    // each acquire the lock and rotate the single-use token in series.
    await Promise.all([live.channel.getCursor(), live.channel.readSince(0), live.channel.getCursor()]);
    expect(refreshSession).toHaveBeenCalledTimes(1);
  });

  it("drops the last-good client once it has expired and a re-mint fails (no polling dead creds)", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt", email: "e@x.io", accessToken: "old", expiresAt: now() - 1 });
    refreshResult = { data: { session: session({ access_token: "t1", expires_at: now() - 1 }) }, error: null }; // mint yields an already-expired token
    const live = liveRemoteBackend("doc-1");
    await live.channel.getCursor(); // inner is set, but its cached expiry is already in the past
    refreshResult = { data: { session: null }, error: { message: "network" } }; // the next re-mint fails
    await expect(live.channel.getCursor()).rejects.toThrow(/inplan login/); // expired inner ⇒ surfaced, not reused
    expect(live.tokenNow()).toBeNull(); // …and the expired client is DISCARDED, not left exposed via tokenNow()/subscribe()
  });

  it("discards the cached client when another process logs out, even if the token hasn't expired", async () => {
    // Token is valid but within the skew, so each call re-mints. First call mints; then auth.json is
    // removed (a logout elsewhere). The next re-mint must clear the cached client rather than keep
    // serving a still-unexpired-but-revoked session.
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt", email: "e@x.io", accessToken: "valid", expiresAt: now() + 60 });
    refreshResult = { data: { session: session({ access_token: "valid", expires_at: now() + 60 }) }, error: null };
    const live = liveRemoteBackend("doc-1");
    await live.channel.getCursor();
    expect(live.tokenNow()).not.toBeNull(); // authenticated so far
    rmSync(authPath()); // another process logged out ⇒ loadAuth() is now null
    await expect(live.channel.getCursor()).rejects.toThrow(/inplan login/);
    expect(live.tokenNow()).toBeNull(); // cached client dropped despite the token not being expired
  });
});

describe("withAuthLock", () => {
  it("acquires a free lock and runs fn", async () => {
    const fn = vi.fn(async () => "ran");
    const r = await withAuthLock(fn, { waitMs: 2000 });
    expect(r).toEqual({ acquired: true, value: "ran" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("reclaims a STALE lock (atomically) and runs fn", async () => {
    mkdirSync(join(home, "auth.lock")); // a leftover lock from a crashed holder
    const fn = vi.fn(async () => "ran");
    const r = await withAuthLock(fn, { staleMs: -1, waitMs: 2000 }); // staleMs:-1 ⇒ treat any lock as stale
    expect(r).toEqual({ acquired: true, value: "ran" });
    expect(fn).toHaveBeenCalledOnce();
  });

  it("does NOT run fn when a fresh lock is held and can't be acquired (no unlocked refresh)", async () => {
    mkdirSync(join(home, "auth.lock")); // held by a live holder; fresh ⇒ never reclaimed
    const fn = vi.fn(async () => "ran");
    const r = await withAuthLock(fn, { staleMs: 999_999, waitMs: 150 });
    expect(r).toEqual({ acquired: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it("fences a reclaimed holder: stillMine() flips false once the owner marker changes (paused-then-stolen)", async () => {
    // Simulate this process being paused past staleMs and a successor stealing the lock: the owner
    // marker no longer carries our token, so stillMine() must report false — the signal the refresh
    // path uses to abort rather than rotate the single-use token alongside the new owner.
    const seen: boolean[] = [];
    const r = await withAuthLock(
      async ({ stillMine }) => {
        seen.push(stillMine()); // true — we still own it
        writeFileSync(join(home, "auth.lock", "owner"), "successor-token"); // a reclaimer took over
        seen.push(stillMine()); // false — no longer ours
        return "done";
      },
      { waitMs: 2000 },
    );
    expect(r).toEqual({ acquired: true, value: "done" });
    expect(seen).toEqual([true, false]);
  });

  it("retains ownership across a callback longer than staleMs (heartbeat) — the 2nd fn waits for the 1st", async () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const order: string[] = [];
    // First holder runs WELL past staleMs (600ms ≫ 200ms). Without the heartbeat the second would
    // reclaim the "stale" lock at ~200ms and interleave; with it, the first's lock stays fresh. Wide
    // margins (600/200/50) keep this robust against event-loop stalls on a loaded CI runner.
    const first = withAuthLock(
      async () => {
        order.push("A:start");
        await sleep(600);
        order.push("A:end");
        return "A";
      },
      { staleMs: 200, waitMs: 5000 },
    );
    await sleep(50); // let the first acquire before the second contends
    const second = withAuthLock(
      async () => {
        order.push("B");
        return "B";
      },
      { staleMs: 200, waitMs: 5000 },
    );
    const [ra, rb] = await Promise.all([first, second]);
    expect(ra).toEqual({ acquired: true, value: "A" });
    expect(rb).toEqual({ acquired: true, value: "B" });
    expect(order).toEqual(["A:start", "A:end", "B"]); // B ran only after A completed
  });
});

// The incident's most likely root cause: a refresh response without a rotated token used to be
// papered over with `|| auth.refreshToken`, persisting a token the server had almost certainly just
// spent. The session then looked healthy for the rest of the access token's hour and failed every
// refresh afterwards — exactly one success, then permanent death.
describe("a refresh with no rotated token", () => {
  it("does NOT persist the old refresh token as if it were fresh", async () => {
    seed();
    const before = JSON.parse(readFileSync(authPath(), "utf8")) as { refreshToken: string; accessToken?: string };
    refreshResult = { data: { session: session({ refresh_token: undefined }) }, error: null };
    const s = await authedSession();
    expect(s).toBeNull(); // treated as a failed refresh…
    const after = JSON.parse(readFileSync(authPath(), "utf8")) as { refreshToken: string; accessToken?: string };
    expect(after.refreshToken).toBe(before.refreshToken); // …and the stored token is untouched
    expect(after.accessToken).toBeUndefined(); // no half-written session either
  });

  it("still persists normally when the server does rotate", async () => {
    seed();
    refreshResult = { data: { session: session() }, error: null };
    expect(await authedSession()).not.toBeNull();
    expect((JSON.parse(readFileSync(authPath(), "utf8")) as { refreshToken: string }).refreshToken).toBe("rt-new");
  });
});
