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

import { canInteractiveLogin, ensureLoggedIn, isKnownAgentEnv } from "../src/cli";
import { loadAuth, saveAuth, type AuthFile } from "../src/cliAuth";

let home: string;
const ttyDescriptors: Record<string, PropertyDescriptor | undefined> = {};
// These tests may themselves run inside a coding agent's shell (Claude Code / Codex / Pi markers
// set), which would trip the detection ladder's env rung — scrub and restore around each test.
const scrubbedAgentEnv = new Map<string, string>();
/** Any env key isKnownAgentEnv keys on (kept in sync with cli.ts): Claude Code, Codex, Pi, opt-in. */
const isAgentMarker = (k: string): boolean =>
  k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_") || k === "CODEX_SANDBOX" || k === "PI_CODING_AGENT" || k === "INPLAN_AGENT";

/** Force stdin/stdout's isTTY (a getter on the streams) so "interactive" is deterministic. */
function setTTY(value: boolean): void {
  for (const stream of ["stdin", "stdout"] as const) {
    ttyDescriptors[stream] ??= Object.getOwnPropertyDescriptor(process[stream], "isTTY");
    Object.defineProperty(process[stream], "isTTY", { value, configurable: true });
  }
}

// A credential whose URL refuses connections instantly, so the best-effort identity refresh
// after login fails fast (and swallows) rather than hitting the network in a unit test.
const FAST_FAIL_AUTH: AuthFile = { url: "http://127.0.0.1:1", anonKey: "anon", refreshToken: "r" };

const SIDE_SESSION = "11111111-2222-4333-8444-555555555555";
/** Drop a valid pending-login sidecar into INPLAN_HOME so ensureLoggedIn's resume path engages. */
async function writeSidecar(): Promise<void> {
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { pendingLoginPath } = await import("../src/cliLogin");
  mkdirSync(dirname(pendingLoginPath()), { recursive: true });
  writeFileSync(
    pendingLoginPath(),
    JSON.stringify({
      sessionId: SIDE_SESSION,
      privateKeyPkcs8: "AAAA",
      pollToken: "poll-tok",
      url: `https://web.test/cli-auth?session=${SIDE_SESSION}#pub=y`,
      apiBase: "http://127.0.0.1:1",
      expiresAt: Date.now() + 600_000,
    }),
  );
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-ensure-"));
  process.env.INPLAN_HOME = home;
  delete process.env.CI;
  delete process.env.INPLAN_NO_BROWSER;
  for (const k of Object.keys(process.env)) {
    if (isAgentMarker(k)) {
      scrubbedAgentEnv.set(k, process.env[k]!);
      delete process.env[k];
    }
  }
});

afterEach(() => {
  delete process.env.INPLAN_HOME;
  rmSync(home, { recursive: true, force: true });
  // Delete everything a test BODY may have assigned (CI leaks into every later test in the worker
  // otherwise — ensureLoggedIn branches on it), THEN restore the genuinely-scrubbed originals.
  delete process.env.CI;
  delete process.env.INPLAN_NO_BROWSER;
  for (const k of Object.keys(process.env)) {
    if (isAgentMarker(k)) delete process.env[k];
  }
  for (const [k, v] of scrubbedAgentEnv) process.env[k] = v;
  scrubbedAgentEnv.clear();
  for (const stream of ["stdin", "stdout"] as const) {
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

  it("is false when stdout is piped even though stdin/stderr are TTYs (`… | tool` ⇒ no browser)", () => {
    // The reported case: `inplan wait --remote DOC | tool` — stdout is piped for programmatic use,
    // but stdin and stderr stay TTYs. Must NOT be eligible for a browser login.
    const origStderr = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true }); // piped
    try {
      expect(canInteractiveLogin([])).toBe(false);
    } finally {
      // afterEach restores stdin/stdout; stderr isn't managed there, so reset it here.
      if (origStderr) Object.defineProperty(process.stderr, "isTTY", origStderr);
      else delete (process.stderr as { isTTY?: boolean }).isTTY;
    }
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

  it("headless (no TTY): no browser — routes to the pending-login exit for the agent loop", async () => {
    setTTY(false);
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    expect(await ensureLoggedIn([], login, pendingExit)).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).toHaveBeenCalledOnce();
    expect(loadAuth()).toBeNull();
  });

  it("routes to the pending exit even on a TTY when a coding-agent env marker is present", async () => {
    setTTY(true);
    process.env.CLAUDECODE = "1";
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    expect(await ensureLoggedIn([], login, pendingExit)).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).toHaveBeenCalledOnce();
  });

  it("--no-login: no browser AND no pending session (explicit opt-out keeps the old contract)", async () => {
    setTTY(true);
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    expect(await ensureLoggedIn(["--no-login"], login, pendingExit)).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).not.toHaveBeenCalled();
  });

  it("CI: no browser AND no pending session (nobody will ever complete it)", async () => {
    setTTY(true);
    process.env.CI = "true";
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    expect(await ensureLoggedIn([], login, pendingExit)).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).not.toHaveBeenCalled();
  });

  it("resumes a pending sidecar and signs in when the human completes it (agent loop, half 2)", async () => {
    setTTY(true); // even interactive: the pending session the human may already have opened wins
    await writeSidecar();
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    const pollPending = vi.fn(async (p: { sessionId: string }) => (void p, FAST_FAIL_AUTH));
    expect(await ensureLoggedIn([], login, pendingExit, pollPending)).toBe(true);
    expect(pollPending).toHaveBeenCalledOnce();
    expect(pollPending.mock.calls[0]![0]).toMatchObject({ sessionId: SIDE_SESSION });
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).not.toHaveBeenCalled();
    expect(loadAuth()).toEqual(FAST_FAIL_AUTH);
  });

  it("a transient resume failure returns false without starting any fresh flow", async () => {
    setTTY(true);
    await writeSidecar();
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    const pollPending = vi.fn(async () => {
      throw new Error("login timed out — no response from the browser");
    });
    // Timeout/transport → false; neither a fresh browser login nor a fresh pending session was
    // started (pollLoginSession keeps the sidecar in this case, so the next run resumes it).
    expect(await ensureLoggedIn([], login, pendingExit, pollPending)).toBe(false);
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).not.toHaveBeenCalled();
  });

  it("an EXPIRED pending session falls through to a fresh flow", async () => {
    setTTY(true);
    await writeSidecar();
    const { LoginSessionExpiredError } = await import("../src/cliLogin");
    const login = vi.fn(async () => FAST_FAIL_AUTH);
    const pollPending = vi.fn(async () => {
      throw new LoginSessionExpiredError("expired");
    });
    expect(await ensureLoggedIn([], login, vi.fn(async () => {}), pollPending)).toBe(true);
    expect(login).toHaveBeenCalledOnce(); // interactive human → fresh inline login
  });

  it("the opt-outs run BEFORE the sidecar resume — a stale sidecar must not stall CI", async () => {
    setTTY(true);
    process.env.CI = "true";
    await writeSidecar();
    const login = vi.fn();
    const pendingExit = vi.fn(async () => {});
    const pollPending = vi.fn();
    expect(await ensureLoggedIn([], login, pendingExit, pollPending)).toBe(false);
    expect(pollPending).not.toHaveBeenCalled(); // never waits on a human, not even a pending one
    expect(login).not.toHaveBeenCalled();
    expect(pendingExit).not.toHaveBeenCalled();
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

describe("isKnownAgentEnv", () => {
  it("matches only agent-exclusive markers (a human's plain env stays interactive)", () => {
    expect(isKnownAgentEnv({})).toBe(false);
    expect(isKnownAgentEnv({ TERM: "xterm", CURSOR_TRACE_ID: "x" })).toBe(false); // integrated-terminal humans have this
    expect(isKnownAgentEnv({ CLAUDECODE: "1" })).toBe(true);
    expect(isKnownAgentEnv({ CLAUDE_CODE_SESSION_ID: "abc" })).toBe(true);
    expect(isKnownAgentEnv({ CODEX_SANDBOX: "seatbelt" })).toBe(true); // OpenAI Codex sandboxed run
    expect(isKnownAgentEnv({ PI_CODING_AGENT: "true" })).toBe(true); // earendil-works/pi self-id
    expect(isKnownAgentEnv({ INPLAN_AGENT: "1" })).toBe(true); // explicit opt-in for other harnesses
  });
});
