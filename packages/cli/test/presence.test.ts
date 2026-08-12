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

import { announcePresence } from "../src/presence";

describe("announcePresence", () => {
  it("publishes {kind:'agent', agentLocation:'local'} to the doc's awareness room", () => {
    announcePresence("doc-1", "jwt-token");
    expect(localState.inplanPresence).toEqual({ kind: "agent", agentLocation: "local" });
    expect((lastProviderConfig as { name: string }).name).toBe("doc-1");
    expect((lastProviderConfig as { token: string }).token).toBe("jwt-token");
  });

  it("includes the model when provided", () => {
    announcePresence("doc-1", "jwt-token", "Opus 4.8");
    expect(localState.inplanPresence).toEqual({ kind: "agent", agentLocation: "local", model: "Opus 4.8" });
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
    announcePresence("doc-1", resolver);
    expect((lastProviderConfig as { token: unknown }).token).toBe(resolver);
  });

  it("surfaces an auth rejection on stderr, marked cosmetic-only", () => {
    const err = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    announcePresence("doc-1", "jwt-token");
    (lastProviderConfig as { onAuthenticationFailed: (d: { reason: string }) => void }).onAuthenticationFailed({ reason: "permission-denied" });
    expect(err).toHaveBeenCalledWith(expect.stringContaining("presence badge auth failed (permission-denied)"));
    expect(err).toHaveBeenCalledWith(expect.stringContaining("cosmetic only"));
    err.mockRestore();
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
