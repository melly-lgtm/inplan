// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Regression test for the release guard that verifies the plugin verifier PUBLIC key is BAKED into
// the shipped CLI bundle (the 0.1.27 bug shipped an empty runtime lookup → live-collab gate dead).
// Proving the guard: a bundle missing the key — or holding only fragments, out-of-order lines, or a
// truncated body — must fail, so a "successful" build can never approve a CLI whose baked key
// `crypto.createPublicKey` couldn't actually load.
import { describe, it, expect } from "vitest";
import { isKeyBaked, spkiBodyLines } from "../../../scripts/lib/bakedKey.mjs";

// The real single-line Ed25519 trust root, and a synthetic multi-line (RSA-style) SPKI to prove the
// guard validates the COMPLETE serialization across wrapped lines, contiguous and in order.
const ED = "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAVP11te5E7xzNJ4reKg0+mAnrr91gcyD1bMr43Homq98=\n-----END PUBLIC KEY-----";
const MULTI =
  "-----BEGIN PUBLIC KEY-----\nAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK\nLLLLMMMMNNNNOOOOPPPPQQQQRRRRSSSSTTTTUUUUVVVV\n-----END PUBLIC KEY-----";

// How the key appears once esbuild `define` bakes it: ONE JS string literal, PEM newlines escaped.
const bakedLike = (pem: string) => `var PLUGIN_PUBLIC_KEY = ${JSON.stringify(pem)};`;

describe("isKeyBaked", () => {
  it("passes when the full key is baked as an escaped string literal (esbuild's emission)", () => {
    expect(isKeyBaked(bakedLike(ED), ED)).toBe(true);
    expect(isKeyBaked(bakedLike(MULTI), MULTI)).toBe(true);
  });

  it("passes for a template-literal bake (real newlines) and CRLF-escaped serialization", () => {
    expect(isKeyBaked(`var k = \`${ED}\`;`, ED)).toBe(true);
    expect(isKeyBaked(`var k = "${MULTI.split("\n").join("\\r\\n")}";`, MULTI)).toBe(true);
  });

  it("fails when the key is absent — the empty runtime lookup that shipped in 0.1.27", () => {
    const dead = 'var PLUGIN_PUBLIC_KEY = process.env.INPLAN_PLUGIN_PUBLIC_KEY ?? "";';
    expect(isKeyBaked(dead, ED)).toBe(false);
  });

  it("fails on a truncated body — a partial fragment must not pass", () => {
    const body = spkiBodyLines(ED)[0] ?? "";
    expect(isKeyBaked(`var k = "-----BEGIN PUBLIC KEY-----\\n${body.slice(0, 20)}";`, ED)).toBe(false);
  });

  it("fails when lines exist only as scattered, non-contiguous fragments", () => {
    const [l1, l2] = spkiBodyLines(MULTI);
    // Every line present somewhere in the bundle, but never as one loadable PEM serialization.
    expect(isKeyBaked(`var a = "${l1}"; var b = "${l2}"; var h = "-----BEGIN PUBLIC KEY-----";`, MULTI)).toBe(false);
  });

  it("fails when the body lines are baked out of order", () => {
    const [l1, l2] = spkiBodyLines(MULTI);
    const reordered = `var k = "-----BEGIN PUBLIC KEY-----\\n${l2}\\n${l1}\\n-----END PUBLIC KEY-----";`;
    expect(isKeyBaked(reordered, MULTI)).toBe(false);
  });

  it("fails on a line-1-only bake of a multi-line key", () => {
    const l1 = spkiBodyLines(MULTI)[0] ?? "";
    expect(isKeyBaked(`var k = "-----BEGIN PUBLIC KEY-----\\n${l1}\\n-----END PUBLIC KEY-----";`, MULTI)).toBe(false);
  });

  it("rejects a missing or degenerate key body", () => {
    expect(isKeyBaked("anything", "")).toBe(false);
    expect(isKeyBaked("anything", "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----")).toBe(false);
  });
});
