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

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { refreshSession, setSession } })),
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

import { authedSession, currentUser, liveRemoteBackend, remoteBackend, saveAuth, authPath, withAuthLock } from "../src/cliAuth";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-auth-"));
  process.env.INPLAN_HOME = home;
  refreshResult = { data: { session: null }, error: null }; // reset so tests don't inherit a prior one's value
  refreshSession.mockClear();
  setSession.mockClear();
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
