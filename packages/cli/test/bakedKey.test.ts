// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression test for the release guard that verifies the plugin verifier PUBLIC key is BAKED into
// the shipped CLI bundle (the 0.1.27 bug shipped an empty runtime lookup → live-collab gate dead).
// Proving the guard: a bundle missing the key — or holding only a truncated/first-line fragment —
// must fail, so a "successful" build can never approve a CLI that can't verify plugins.
import { describe, it, expect } from "vitest";
import { isKeyBaked, spkiBodyLines } from "../../../scripts/lib/bakedKey.mjs";

// The real single-line Ed25519 trust root, and a synthetic multi-line (RSA-style) SPKI to prove the
// guard validates the COMPLETE body across wrapped lines rather than just the first contiguous run.
const ED = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVP11te5E7xzNJ4reKg0+mAnrr91gcyD1bMr43Homq98=\n-----END PUBLIC KEY-----";
const MULTI =
  "-----BEGIN PUBLIC KEY-----\nAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK\nLLLLMMMMNNNNOOOOPPPPQQQQRRRRSSSSTTTTUUUUVVVV\n-----END PUBLIC KEY-----";

// How the key appears once esbuild `define` bakes it: a JS string literal (PEM newlines escaped).
const bakedLike = (pem: string) => `var PLUGIN_PUBLIC_KEY = ${JSON.stringify(pem)};`;

describe("isKeyBaked", () => {
  it("passes when the full single-line key is baked", () => {
    expect(isKeyBaked(bakedLike(ED), ED)).toBe(true);
  });

  it("fails when the key is absent — the empty runtime lookup that shipped in 0.1.27", () => {
    const dead = 'var PLUGIN_PUBLIC_KEY = process.env.INPLAN_PLUGIN_PUBLIC_KEY ?? "";';
    expect(isKeyBaked(dead, ED)).toBe(false);
  });

  it("fails on a truncated body — a partial fragment must not pass", () => {
    const body = spkiBodyLines(ED)[0] ?? "";
    expect(isKeyBaked(`var k = "${body.slice(0, 20)}";`, ED)).toBe(false);
  });

  it("requires EVERY line of a multi-line key (a line-1-only bake fails)", () => {
    const [l1, l2] = spkiBodyLines(MULTI);
    expect(isKeyBaked(`var k = "${l1}";`, MULTI)).toBe(false); // only the first line baked
    expect(isKeyBaked(`var k = "${l1}" + "${l2}";`, MULTI)).toBe(true); // all lines present
  });

  it("rejects a missing or degenerate key body", () => {
    expect(isKeyBaked("anything", "")).toBe(false);
    expect(isKeyBaked("anything", "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----")).toBe(false);
  });
});
