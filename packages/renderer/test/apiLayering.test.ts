// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
//
// The host-api layering: window.api (frozen contextBridge) ← setHostApi (collab-augmented base) ←
// setApiOverride (temporary onboarding sample). Guards the fix for the desktop live-collab merge:
// clearing the onboarding override must fall back to the augmented base, never lose it.

import { afterEach, describe, expect, it } from "vitest";
import { hostApi, realHostApi, setApiOverride, setHostApi, type Api } from "../src/api";

const stub = (tag: string): Api => ({ tag } as unknown as Api);
const tagOf = (api: Api): string => (api as unknown as { tag: string }).tag;

afterEach(() => {
  setApiOverride(null);
  setHostApi(undefined as unknown as Api); // reset the installed base back to window.api
});

describe("host-api layering", () => {
  it("defaults to window.api when nothing is installed", () => {
    (window as unknown as { api: Api }).api = stub("window");
    expect(tagOf(hostApi())).toBe("window");
    expect(tagOf(realHostApi())).toBe("window");
  });

  it("setHostApi installs the augmented base for both hostApi and realHostApi", () => {
    (window as unknown as { api: Api }).api = stub("window");
    setHostApi(stub("collab"));
    expect(tagOf(hostApi())).toBe("collab");
    expect(tagOf(realHostApi())).toBe("collab");
  });

  it("an onboarding override wins for hostApi but realHostApi still sees the base", () => {
    (window as unknown as { api: Api }).api = stub("window");
    setHostApi(stub("collab"));
    setApiOverride(stub("sample"));
    expect(tagOf(hostApi())).toBe("sample");
    expect(tagOf(realHostApi())).toBe("collab");
  });

  it("clearing the onboarding override falls back to the augmented base, not window.api", () => {
    (window as unknown as { api: Api }).api = stub("window");
    setHostApi(stub("collab"));
    setApiOverride(stub("sample"));
    setApiOverride(null);
    expect(tagOf(hostApi())).toBe("collab"); // collab survives the tour, not lost to window.api
  });
});
