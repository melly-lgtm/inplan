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

vi.mock("@supabase/supabase-js", () => ({
  createClient: vi.fn(() => ({ auth: { refreshSession } })),
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
});
afterEach(() => {
  delete process.env.INPLAN_HOME;
  vi.clearAllMocks();
});

const seed = () => saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt-old", email: "old@x.io" });
const session = (over: Record<string, unknown> = {}) => ({
  refresh_token: "rt-new",
  access_token: "jwt-123",
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

  it("refreshes, persisting the rotated token + email", async () => {
    seed();
    refreshResult = { data: { session: session() }, error: null };
    const s = await authedSession();
    expect(s?.session.access_token).toBe("jwt-123");
    const stored = JSON.parse(readFileSync(authPath(), "utf8"));
    expect(stored.refreshToken).toBe("rt-new");
    expect(stored.email).toBe("new@x.io");
  });

  it("does not rewrite when the token + email are unchanged", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "anon", refreshToken: "rt-same", email: "same@x.io" });
    refreshResult = { data: { session: session({ refresh_token: "rt-same", user: { id: "u", email: "same@x.io" } }) }, error: null };
    const before = readFileSync(authPath(), "utf8");
    await authedSession();
    expect(readFileSync(authPath(), "utf8")).toBe(before);
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
