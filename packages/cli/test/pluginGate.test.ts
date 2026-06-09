// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it, vi } from "vitest";
import { loadPluginGate, type PluginGateDeps } from "../src/pluginGate";
import type { ResolvedPlugin } from "@inplan/core/node";

const SESSION = "ws://127.0.0.1:51234";

/** A resolved bundle with a fake verified CLI entry. */
const bundle = (files: Record<string, string>, cli?: string): ResolvedPlugin => ({
  lease: { sub: "u1", plan: "pro", features: ["instant"], iat: 0, exp: 9_999_999_999_999 },
  version: "v1",
  files,
  entries: cli ? { cli } : {},
});

/** Build injectable deps with a stub resolve + a stub CLI entry whose gate() returns a PluginGate. */
function deps(over: Partial<PluginGateDeps> & { gate?: { readCanonical: ReturnType<typeof vi.fn>; applyRevision: ReturnType<typeof vi.fn> } } = {}): PluginGateDeps {
  const gate = over.gate ?? { readCanonical: vi.fn(async () => "live body"), applyRevision: vi.fn(async () => {}) };
  return {
    resolve: over.resolve ?? (async () => bundle({ "cli.js": "/cache/v1/cli.js" }, "cli.js")),
    importCli: over.importCli ?? (async () => ({ gate: () => gate })),
  };
}

describe("loadPluginGate", () => {
  it("entitled + CLI entry in the bundle → the gate the plugin's gate(session) returns", async () => {
    const gateImpl = { readCanonical: vi.fn(async () => "live body"), applyRevision: vi.fn(async () => {}) };
    const gateFn = vi.fn(() => gateImpl);
    const gate = await loadPluginGate(SESSION, { token: "jwt" }, deps({ importCli: async () => ({ gate: gateFn }) }));
    expect(gate).not.toBeNull();
    expect(gateFn).toHaveBeenCalledWith(SESSION); // the opaque session is handed back to the plugin
    expect(await gate!.readCanonical()).toBe("live body");
    await gate!.applyRevision("new body");
    expect(gateImpl.applyRevision).toHaveBeenCalledWith("new body");
  });

  it("not entitled (resolve → null) → null, and never imports the CLI entry", async () => {
    const importCli = vi.fn();
    const gate = await loadPluginGate(SESSION, { token: "jwt" }, deps({ resolve: async () => null, importCli }));
    expect(gate).toBeNull();
    expect(importCli).not.toHaveBeenCalled();
  });

  it("bundle has no cli entry (renderer-only plugin) → null, and never imports", async () => {
    const importCli = vi.fn();
    const gate = await loadPluginGate(SESSION, { token: "jwt" }, deps({ resolve: async () => bundle({ "renderer.js": "/cache/v1/renderer.js" }), importCli }));
    expect(gate).toBeNull();
    expect(importCli).not.toHaveBeenCalled();
  });

  it("fail-soft: resolve throws → null", async () => {
    const gate = await loadPluginGate(SESSION, { token: "jwt" }, deps({ resolve: async () => { throw new Error("network"); } }));
    expect(gate).toBeNull();
  });

  it("fail-soft: importing the verified CLI entry throws → null", async () => {
    const gate = await loadPluginGate(SESSION, { token: "jwt" }, deps({ importCli: async () => { throw new Error("bad module"); } }));
    expect(gate).toBeNull();
  });

  it("threads token + an explicit publicKey/cacheDir/apiBase into resolve", async () => {
    const resolve = vi.fn(async () => bundle({ "cli.js": "/cache/v1/cli.js" }, "cli.js"));
    await loadPluginGate(SESSION, { token: null, apiBase: "https://plugin.test", cacheDir: "/tmp/cache", publicKey: "PEM" }, deps({ resolve }));
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ token: null, apiBase: "https://plugin.test", cacheDir: "/tmp/cache", publicKey: "PEM" }));
  });
});
