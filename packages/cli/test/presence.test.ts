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

import { announcePresence, presenceTokenResolver } from "../src/presence";

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
    announcePresence("doc-1", "jwt-token");
    vi.advanceTimersByTime(15_000);
    expect(err).toHaveBeenCalledWith(expect.stringContaining("did not authenticate"));
    err.mockRestore();
    vi.useRealTimers();
  });

  it("stays silent when authenticated in time; destroy() cancels the pending check", () => {
    vi.useFakeTimers();
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announcePresence("doc-1", "jwt-token");
    lastProviderInstance!.isAuthenticated = true; // authenticated before the grace elapses
    vi.advanceTimersByTime(15_000);
    expect(err).not.toHaveBeenCalled();
    const p2 = announcePresence("doc-2", "jwt-token");
    p2.destroy(); // teardown before the grace elapses must cancel the report
    vi.advanceTimersByTime(15_000);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
    vi.useRealTimers();
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
