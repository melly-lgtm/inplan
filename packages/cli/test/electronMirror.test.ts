// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The mirror used to auto-recover a missing Electron binary (its GitHub postinstall download was
// blocked by a proxy/firewall/AV). An explicit ELECTRON_MIRROR wins; otherwise we default to
// npmmirror so `inplan open` can self-heal instead of falling back to headless.

import { describe, it, expect } from "vitest";
import { electronMirror } from "../src/cli";

const NPMMIRROR = "https://npmmirror.com/mirrors/electron/";

describe("electronMirror", () => {
  it("prefers an explicit ELECTRON_MIRROR", () => {
    expect(electronMirror({ ELECTRON_MIRROR: "https://my.mirror/electron/" })).toBe("https://my.mirror/electron/");
  });
  it("trims surrounding whitespace on the env value", () => {
    expect(electronMirror({ ELECTRON_MIRROR: "  https://m/e/  " })).toBe("https://m/e/");
  });
  it("defaults to npmmirror when unset", () => {
    expect(electronMirror({})).toBe(NPMMIRROR);
  });
  it("defaults to npmmirror when blank/whitespace-only", () => {
    expect(electronMirror({ ELECTRON_MIRROR: "   " })).toBe(NPMMIRROR);
    expect(electronMirror({ ELECTRON_MIRROR: "" })).toBe(NPMMIRROR);
  });
});
