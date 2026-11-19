// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The rule: after activation settles, the installed api describes THIS document — the new
// activation's capabilities, or the plain file-backed api, never a previous document's. A binding
// left over from the document we navigated away from still answers "bound" and still writes, to
// the wrong document.

import { describe, expect, it, vi } from "vitest";
import type { Api } from "@inplan/renderer";
import { createPluginActivator, type PluginExt } from "../src/renderer/pluginActivation";
import { navigationSignal } from "../src/main/navSignal";

const BASE = { load: async () => ({ path: "p", content: "" }) } as unknown as Api;
const ext = (name: string): PluginExt & { dispose: ReturnType<typeof vi.fn> } => ({
  binding: { extensions: [], getText: () => name } as unknown as Api["binding"],
  dispose: vi.fn(),
});

function harness(script: Array<{ info: { session: string; rendererUrl: string } | null; ext?: PluginExt | null; throws?: boolean }>) {
  let step = 0;
  let installed: Api | null = null;
  const errors: unknown[] = [];
  const activator = createPluginActivator({
    getInfo: async () => script[step]!.info,
    importModule: async () => ({
      activate: () => {
        const s = script[step]!;
        if (s.throws) throw new Error("activate blew up");
        return s.ext ?? null;
      },
    }),
    baseApi: () => BASE,
    install: (api) => (installed = api),
    onError: (e) => errors.push(e),
  });
  return {
    activator,
    errors,
    installed: () => installed,
    next: async () => {
      await activator.activate();
      step += 1;
    },
  };
}
const INFO = { session: "s", rendererUrl: "u" };

describe("plugin activation across documents", () => {
  it("installs the plugin's capabilities when one activates", async () => {
    const a = ext("doc A");
    const h = harness([{ info: INFO, ext: a }]);
    await h.next();
    expect(h.installed()?.binding?.getText()).toBe("doc A");
    expect(h.activator.active).toBe(true);
  });

  it("drops the previous document's binding when the next document has NO plugin info", async () => {
    // The plugin worked for doc A and failed to start for doc B. Returning early here used to
    // leave doc A's api installed: "am I bound?" answered yes, and writes went to doc A.
    const a = ext("doc A");
    const h = harness([{ info: INFO, ext: a }, { info: null }]);
    await h.next();
    await h.next();
    expect(h.installed()?.binding).toBeUndefined(); // the file-backed api, INSTALLED
    expect(a.dispose).toHaveBeenCalledTimes(1); // and the old activation torn down
    expect(h.activator.active).toBe(false);
  });

  it("drops it when the plugin declines the next document", async () => {
    const a = ext("doc A");
    const h = harness([{ info: INFO, ext: a }, { info: INFO, ext: null }]);
    await h.next();
    await h.next();
    expect(h.installed()?.binding).toBeUndefined();
    expect(a.dispose).toHaveBeenCalledTimes(1);
  });

  it("drops it when activation throws, and never rejects", async () => {
    const a = ext("doc A");
    const h = harness([{ info: INFO, ext: a }, { info: INFO, throws: true }]);
    await h.next();
    await expect(h.next()).resolves.toBeUndefined();
    expect(h.installed()?.binding).toBeUndefined();
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(h.errors).toHaveLength(1);
  });

  it("re-points to the next document's binding and disposes the old one", async () => {
    const a = ext("doc A");
    const b = ext("doc B");
    const h = harness([{ info: INFO, ext: a }, { info: INFO, ext: b }]);
    await h.next();
    await h.next();
    expect(h.installed()?.binding?.getText()).toBe("doc B");
    expect(a.dispose).toHaveBeenCalledTimes(1);
    expect(b.dispose).not.toHaveBeenCalled();
  });
});

describe("navigationSignal", () => {
  it("re-runs activation when the PREVIOUS document had a plugin, even if this one has none", () => {
    // Otherwise the renderer keeps the previous document's binding and is only told to show a new
    // document — with every programmatic body write still going to the old one.
    expect(navigationSignal(true, false)).toBe("reactivate");
  });
  it("re-runs it when this document has one", () => {
    expect(navigationSignal(false, true)).toBe("reactivate");
    expect(navigationSignal(true, true)).toBe("reactivate");
  });
  it("just navigates when no plugin is involved on either side", () => {
    expect(navigationSignal(false, false)).toBe("navigated");
  });
});
