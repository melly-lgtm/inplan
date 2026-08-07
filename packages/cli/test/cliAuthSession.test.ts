// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Covers the authenticated-session paths of cliAuth (refresh, rotation persist,
// remoteBackend wiring) with a mocked supabase-js — no network, no real creds.

import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
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
  SupabaseControlChannel: class { constructor(public db: unknown, public docId: string, public consumer: string) {} },
  SupabaseDocumentStore: class { constructor(public db: unknown, public docId: string) {} },
}));

import { authedSession, currentUser, remoteBackend, saveAuth, authPath } from "../src/cliAuth";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-auth-"));
  process.env.INPLAN_HOME = home;
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
