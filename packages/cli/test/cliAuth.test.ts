// SPDX-License-Identifier: AGPL-3.0-or-later

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authPath, clearAuth, loadAuth, saveAuth } from "../src/cliAuth";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-auth-"));
  process.env.INPLAN_HOME = home;
});

afterEach(() => {
  delete process.env.INPLAN_HOME;
  rmSync(home, { recursive: true, force: true });
});

describe("cliAuth", () => {
  it("authPath honors INPLAN_HOME", () => {
    expect(authPath()).toBe(join(home, "auth.json"));
  });

  it("round-trips credentials and writes them owner-only", () => {
    const auth = { url: "https://x.supabase.co", anonKey: "anon-123", refreshToken: "refresh-abc" };
    saveAuth(auth);
    expect(loadAuth()).toEqual(auth);
    // 0o600 — the file holds a session token, so it must not be group/world readable.
    expect(statSync(authPath()).mode & 0o077).toBe(0);
  });

  it("round-trips the optional email label", () => {
    const auth = { url: "https://x.supabase.co", anonKey: "anon-123", refreshToken: "r", email: "diane@example.com" };
    saveAuth(auth);
    expect(loadAuth()).toEqual(auth);
  });

  it("clearAuth signs out (removes the file)", () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "a", refreshToken: "r" });
    expect(loadAuth()).not.toBeNull();
    clearAuth();
    expect(existsSync(authPath())).toBe(false);
    expect(loadAuth()).toBeNull();
    clearAuth(); // idempotent — no throw when already signed out
  });

  it("returns null when not logged in", () => {
    expect(loadAuth()).toBeNull();
  });

  it("returns null on corrupt or incomplete credentials", () => {
    writeFileSync(authPath(), "{ not json");
    expect(loadAuth()).toBeNull();
    writeFileSync(authPath(), JSON.stringify({ url: "https://x.supabase.co" })); // missing keys
    expect(loadAuth()).toBeNull();
  });
});
