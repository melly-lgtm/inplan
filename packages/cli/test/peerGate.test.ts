// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { loadHubGate, type PeerGateDeps } from "../src/peerGate";
import type { ResolvedCollab } from "@inplan/core/node";

const HUB = "ws://127.0.0.1:51234";

/** A resolved bundle with a fake verified peer.js path. */
const bundle = (files: Record<string, string>): ResolvedCollab => ({
  lease: { sub: "u1", plan: "pro", features: ["instant"], iat: 0, exp: 9_999_999_999_999 },
  version: "v1",
  files,
});

/** Build injectable deps with a stub resolve + a stub peer module. */
function deps(over: Partial<PeerGateDeps> & { peer?: { readDocViaHub: ReturnType<typeof vi.fn>; applyRevisionViaHub: ReturnType<typeof vi.fn> } } = {}): PeerGateDeps {
  const peer = over.peer ?? { readDocViaHub: vi.fn(async () => "live body"), applyRevisionViaHub: vi.fn(async () => {}) };
  return {
    resolve: over.resolve ?? (async () => bundle({ "peer.js": "/cache/v1/peer.js" })),
    importPeer: over.importPeer ?? (async () => peer),
  };
}

describe("loadHubGate", () => {
  it("entitled + peer in the bundle → a gate that delegates to the verified peer (with the hub URL)", async () => {
    const peer = { readDocViaHub: vi.fn(async () => "live body"), applyRevisionViaHub: vi.fn(async () => {}) };
    const gate = await loadHubGate(HUB, { token: "jwt" }, deps({ peer }));
    expect(gate).not.toBeNull();
    expect(await gate!.readCanonical()).toBe("live body");
    expect(peer.readDocViaHub).toHaveBeenCalledWith(HUB, expect.objectContaining({ timeoutMs: expect.any(Number) }));
    await gate!.applyRevision("new body");
    expect(peer.applyRevisionViaHub).toHaveBeenCalledWith(HUB, "new body", expect.objectContaining({ timeoutMs: expect.any(Number) }));
  });

  it("not entitled (resolve → null) → null, and never imports a peer", async () => {
    const importPeer = vi.fn();
    const gate = await loadHubGate(HUB, { token: "jwt" }, deps({ resolve: async () => null, importPeer }));
    expect(gate).toBeNull();
    expect(importPeer).not.toHaveBeenCalled();
  });

  it("bundle lacks peer.js (desktop-only entitlement) → null, and never imports", async () => {
    const importPeer = vi.fn();
    const gate = await loadHubGate(HUB, { token: "jwt" }, deps({ resolve: async () => bundle({ "desktop.js": "/cache/v1/desktop.js" }), importPeer }));
    expect(gate).toBeNull();
    expect(importPeer).not.toHaveBeenCalled();
  });

  it("fail-soft: resolve throws → null", async () => {
    const gate = await loadHubGate(HUB, { token: "jwt" }, deps({ resolve: async () => { throw new Error("network"); } }));
    expect(gate).toBeNull();
  });

  it("fail-soft: importing the verified peer throws → null", async () => {
    const gate = await loadHubGate(HUB, { token: "jwt" }, deps({ importPeer: async () => { throw new Error("bad module"); } }));
    expect(gate).toBeNull();
  });

  it("threads token + an explicit publicKey/cacheDir/apiBase into resolve", async () => {
    const resolve = vi.fn(async () => bundle({ "peer.js": "/cache/v1/peer.js" }));
    await loadHubGate(HUB, { token: null, apiBase: "https://collab.test", cacheDir: "/tmp/cache", publicKey: "PEM" }, deps({ resolve }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ token: null, apiBase: "https://collab.test", cacheDir: "/tmp/cache", publicKey: "PEM" }));
  });
});
