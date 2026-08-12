// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";

// A controllable awareness + socket/provider double so tests can assert on the published
// state and on teardown, without a real Hocuspocus connection.
const localState: Record<string, unknown> = {};
let destroyedProvider = false;
let destroyedSocket = false;
let destroyedDoc = false;
let lastWebsocketConfig: unknown;
let lastProviderConfig: unknown;
let lastProviderInstance: { isAuthenticated: boolean } | undefined;

vi.mock("@hocuspocus/provider", () => ({
  HocuspocusProviderWebsocket: class {
    constructor(config: unknown) {
      lastWebsocketConfig = config;
    }
    destroy() {
      destroyedSocket = true;
    }
  },
  HocuspocusProvider: class {
    isAuthenticated = false;
    awareness = {
      setLocalStateField: (field: string, value: unknown) => {
        localState[field] = value;
      },
    };
    constructor(config: unknown) {
      lastProviderConfig = config;
      lastProviderInstance = this;
    }
    destroy() {
      destroyedProvider = true;
    }
  },
}));

vi.mock("yjs", () => ({
  Doc: class {
    destroy() {
      destroyedDoc = true;
    }
  },
}));

import { announcePresence, presenceTokenResolver, AUTH_REPORT_DELAY_MS } from "../src/presence";

/** A structurally valid JWT whose payload carries `exp` (epoch seconds) — enough for jwtExpMs. */
const jwtWithExp = (expSec: number) => `h.${Buffer.from(JSON.stringify({ exp: expSec })).toString("base64url")}.sig`;

describe("announcePresence", () => {
  it("publishes {kind:'agent', agentLocation:'local'} to the doc's awareness room", () => {
    const p = announcePresence("doc-1", "jwt-token");
    expect(localState.inplanPresence).toEqual({ kind: "agent", agentLocation: "local" });
    expect((lastProviderConfig as { name: string }).name).toBe("doc-1");
    expect((lastProviderConfig as { token: string }).token).toBe("jwt-token");
    p.destroy(); // cancel the pending auth check — it must not fire into a later test's stderr
  });

  it("includes the model when provided", () => {
    const p = announcePresence("doc-1", "jwt-token", "Opus 4.8");
    expect(localState.inplanPresence).toEqual({ kind: "agent", agentLocation: "local", model: "Opus 4.8" });
    p.destroy();
  });

  it("destroy() tears down the provider, socket, and doc", () => {
    const presence = announcePresence("doc-1", "jwt-token");
    presence.destroy();
    expect(destroyedProvider).toBe(true);
    expect(destroyedSocket).toBe(true);
    expect(destroyedDoc).toBe(true);
  });

  it("passes a token RESOLVER through to the provider (reconnects re-resolve; a frozen string goes stale)", () => {
    const resolver = async () => "fresh-jwt";
    const p = announcePresence("doc-1", resolver);
    expect((lastProviderConfig as { token: unknown }).token).toBe(resolver);
    p.destroy(); // cancel the pending auth check — it must not fire into a later test's stderr
  });

  it("surfaces an auth rejection on stderr, marked cosmetic-only", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p = announcePresence("doc-1", "jwt-token");
    try {
      (lastProviderConfig as { onAuthenticationFailed: (d: { reason: string }) => void }).onAuthenticationFailed({ reason: "permission-denied" });
      expect(err).toHaveBeenCalledWith(expect.stringContaining("presence badge auth failed (permission-denied)"));
      expect(err).toHaveBeenCalledWith(expect.stringContaining("cosmetic only"));
    } finally {
      p.destroy();
      err.mockRestore();
    }
  });

  it("presenceTokenResolver: re-mints, keeps the last good token on a transient throw, fails on sign-out", async () => {
    let mode: "ok" | "throw" | "null" = "ok";
    let minted = 0;
    const resolve = presenceTokenResolver("initial-jwt", async () => {
      if (mode === "throw") throw new Error("network blip");
      if (mode === "null") return null;
      minted += 1;
      return { token: `fresh-${minted}` };
    });
    await expect(resolve()).resolves.toBe("fresh-1"); // re-mints on each call
    mode = "throw";
    await expect(resolve()).resolves.toBe("fresh-1"); // transient → last GOOD token, not the initial
    mode = "null";
    await expect(resolve()).rejects.toThrow(/signed out/); // definitive → never re-send a stale token
    mode = "ok";
    await expect(resolve()).resolves.toBe("fresh-2"); // a recovered session resumes minting
  });

  it("reports a channel that never authenticates (the silent Unauthorized death — issue #88)", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p = announcePresence("doc-1", "jwt-token");
    vi.advanceTimersByTime(AUTH_REPORT_DELAY_MS);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("did not authenticate"));
    p.destroy();
    err.mockRestore();
    vi.useRealTimers();
  });

  it("stays silent when authenticated in time; destroy() cancels the pending check", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p1 = announcePresence("doc-1", "jwt-token");
    lastProviderInstance!.isAuthenticated = true; // authenticated before the grace elapses
    (lastProviderConfig as { onAuthenticated: () => void }).onAuthenticated(); // …which also clears the timer
    vi.advanceTimersByTime(AUTH_REPORT_DELAY_MS);
    expect(err).not.toHaveBeenCalled();
    const p2 = announcePresence("doc-2", "jwt-token");
    p2.destroy(); // teardown before the grace elapses must cancel the report
    vi.advanceTimersByTime(AUTH_REPORT_DELAY_MS);
    expect(err).not.toHaveBeenCalled();
    p1.destroy();
    err.mockRestore();
    vi.useRealTimers();
  });

  it("corrects a false alarm: a slow-but-successful auth after the grace emits a recovery line", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p = announcePresence("doc-1", "jwt-token");
    vi.advanceTimersByTime(AUTH_REPORT_DELAY_MS); // grace elapses unauthenticated → report fires
    expect(err).toHaveBeenCalledWith(expect.stringContaining("did not authenticate"));
    lastProviderInstance!.isAuthenticated = true;
    (lastProviderConfig as { onAuthenticated: () => void }).onAuthenticated(); // auth lands late
    expect(err).toHaveBeenCalledWith(expect.stringContaining("authenticated after all"));
    p.destroy();
    err.mockRestore();
    vi.useRealTimers();
  });

  it("re-arms the check per reconnect: a silent death at hour 2 is still reported", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const p = announcePresence("doc-1", "jwt-token");
    lastProviderInstance!.isAuthenticated = true;
    (lastProviderConfig as { onAuthenticated: () => void }).onAuthenticated(); // initial connect: fine
    vi.advanceTimersByTime(AUTH_REPORT_DELAY_MS);
    expect(err).not.toHaveBeenCalled();
    // Hub restart hours later: the provider reconnects but never re-authenticates (the 4401 death).
    lastProviderInstance!.isAuthenticated = false;
    (lastProviderConfig as { onOpen: () => void }).onOpen(); // reconnect re-arms its own grace window
    vi.advanceTimersByTime(AUTH_REPORT_DELAY_MS);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("did not authenticate"));
    p.destroy();
    err.mockRestore();
    vi.useRealTimers();
  });

  it("bounds the transient fallback by the cached JWT's expiry (no stale-token reconnect loop)", async () => {
    // A prolonged refresh outage: mint keeps throwing. While the last good JWT is unexpired the
    // fallback returns it; once it has expired, the resolver must reject rather than re-send it
    // on every reconnect.
    const fresh = jwtWithExp(Math.floor(Date.now() / 1000) + 3600); // valid for an hour
    let now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const resolve = presenceTokenResolver(fresh, async () => {
        throw new Error("refresh outage");
      });
      await expect(resolve()).resolves.toBe(fresh); // unexpired → fallback holds
      now += 2 * 3600 * 1000; // two hours later, still in the outage
      await expect(resolve()).rejects.toThrow(/expired during a refresh outage/);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps the plain fallback for an opaque (non-JWT) token — expiry unreadable", async () => {
    const resolve = presenceTokenResolver("opaque-token", async () => {
      throw new Error("refresh outage");
    });
    await expect(resolve()).resolves.toBe("opaque-token");
  });

  it("is best-effort: a construction failure returns a no-op handle instead of throwing", async () => {
    vi.resetModules();
    vi.doMock("@hocuspocus/provider", () => ({
      HocuspocusProviderWebsocket: class {
        constructor() {
          throw new Error("no network");
        }
      },
      HocuspocusProvider: class {},
    }));
    const { announcePresence: announceWithBrokenSocket } = await import("../src/presence");
    expect(() => announceWithBrokenSocket("doc-1", "jwt-token")).not.toThrow();
    const presence = announceWithBrokenSocket("doc-1", "jwt-token");
    expect(() => presence.destroy()).not.toThrow();
    vi.doUnmock("@hocuspocus/provider");
  });
});
