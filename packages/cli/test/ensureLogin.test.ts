// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Auto-login (#3a): `inplan wait --remote <doc>` self-heals a fresh machine by running the
// browser handoff inline — but ONLY for an interactive human. These tests pin the decision
// logic: credentials present → no browser; headless / --no-login / CI → no browser (caller
// errors); interactive + no creds → login runs and the credentials are persisted.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Stub only the post-login identity refresh (currentUser → network) so ensureLoggedIn's
// best-effort `persistCloudIdentity` never touches the network in these unit tests. loadAuth /
// saveAuth (and everything else) stay real so credential persistence is genuinely exercised.
vi.mock("../src/cliAuth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/cliAuth")>()),
  currentUser: vi.fn(async () => null),
}));

import { canInteractiveLogin, ensureLoggedIn } from "../src/cli";
import { loadAuth, saveAuth, type AuthFile } from "../src/cliAuth";

let home: string;
const ttyDescriptors: Record<string, PropertyDescriptor | undefined> = {};

/** Force stdin/stderr's isTTY (a getter on the streams) so "interactive" is deterministic. */
function setTTY(value: boolean): void {
  for (const stream of ["stdin", "stderr"] as const) {
    ttyDescriptors[stream] ??= Object.getOwnPropertyDescriptor(process[stream], "isTTY");
    Object.defineProperty(process[stream], "isTTY", { value, configurable: true });
  }
}

// A credential whose URL refuses connections instantly, so the best-effort identity refresh
// after login fails fast (and swallows) rather than hitting the network in a unit test.
const FAST_FAIL_AUTH: AuthFile = { url: "http://127.0.0.1:1", anonKey: "anon", refreshToken: "r" };

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-ensure-"));
  process.env.INPLAN_HOME = home;
  delete process.env.CI;
  delete process.env.INPLAN_NO_BROWSER;
});

afterEach(() => {
  delete process.env.INPLAN_HOME;
  rmSync(home, { recursive: true, force: true });
  for (const stream of ["stdin", "stderr"] as const) {
    if (ttyDescriptors[stream]) {
      Object.defineProperty(process[stream], "isTTY", ttyDescriptors[stream]!);
    } else {
      delete (process[stream] as { isTTY?: boolean }).isTTY; // no original descriptor → drop the injected own-prop
    }
    ttyDescriptors[stream] = undefined;
  }
});

describe("canInteractiveLogin", () => {
  it("is true only with a TTY on both ends and no CI / --no-login / opt-out", () => {
    setTTY(true);
    expect(canInteractiveLogin([])).toBe(true);
    expect(canInteractiveLogin(["--no-login"])).toBe(false);
    process.env.CI = "true";
    expect(canInteractiveLogin([])).toBe(false);
    delete process.env.CI;
    process.env.INPLAN_NO_BROWSER = "1";
    expect(canInteractiveLogin([])).toBe(false);
  });

  it("is false without a TTY even when nothing else opts out", () => {
    setTTY(false);
    expect(canInteractiveLogin([])).toBe(false);
  });
});

describe("ensureLoggedIn", () => {
  it("short-circuits (no browser) when credentials already exist", async () => {
    saveAuth({ url: "https://x.supabase.co", anonKey: "a", refreshToken: "r" });
    setTTY(true);
    const login = vi.fn();
    expect(await ensureLoggedIn([], login)).toBe(true);
    expect(login).not.toHaveBeenCalled();
  });

  it("does NOT open a browser when headless (no TTY) — the caller errors instead", async () => {
    setTTY(false);
    const login = vi.fn();
    expect(await ensureLoggedIn([], login)).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(loadAuth()).toBeNull();
  });

  it("does NOT open a browser under --no-login even when interactive", async () => {
    setTTY(true);
    const login = vi.fn();
    expect(await ensureLoggedIn(["--no-login"], login)).toBe(false);
    expect(login).not.toHaveBeenCalled();
  });

  it("does NOT open a browser under CI even when interactive", async () => {
    setTTY(true);
    process.env.CI = "true";
    const login = vi.fn();
    expect(await ensureLoggedIn([], login)).toBe(false);
    expect(login).not.toHaveBeenCalled();
  });

  it("runs the login handoff and persists credentials when interactive with none stored", async () => {
    setTTY(true);
    const login = vi.fn(async () => FAST_FAIL_AUTH);
    expect(await ensureLoggedIn([], login)).toBe(true);
    expect(login).toHaveBeenCalledOnce();
    expect(loadAuth()).toEqual(FAST_FAIL_AUTH); // stored so the very next remoteBackend() call is authenticated
  });

  it("returns false (and stores nothing) when the login handoff fails", async () => {
    setTTY(true);
    const login = vi.fn(async () => {
      throw new Error("login timed out — no response from the browser");
    });
    expect(await ensureLoggedIn([], login)).toBe(false);
    expect(loadAuth()).toBeNull();
  });
});
