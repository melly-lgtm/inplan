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
    awareness = {
      setLocalStateField: (field: string, value: unknown) => {
        localState[field] = value;
      },
    };
    constructor(config: unknown) {
      lastProviderConfig = config;
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
