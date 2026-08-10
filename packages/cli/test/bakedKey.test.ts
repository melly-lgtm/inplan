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
// A REAL multi-line SPKI (RSA-2048): isKeyBaked parse-gates the configured key with
// createPublicKey, so a synthetic base64 blob would fail before the matcher even ran.
const MULTI =
  "-----BEGIN PUBLIC KEY-----\nMIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkZbA4lx2KQSZMCNcDU35\nkdc/t/+/YYpg6vP9IYXyJk+kAzFmYSpO1S37GkUQgDYpxz+MzTvTPou4FW6wNEX0\nJpdQxUOyyjCmhXF9dN51WMn+hJNxM04Vh1gMfb2EpIHdykebgi9ii1zP+KUxN19m\ndoAg8Ci9lP19kZkuGUlkN+FTdyzW2GK7H1t9hL3NG4CkV2SU6DOhGxe0fhAYz3Mg\nYcvgwKusGSGispUqc926e09t85NMZERVnVXAUGbqOjvJL2xfU49TOu1jOkaz4yv9\njvkiX+5pyhYR2UaEbtSGWvZ+QxR5S1R5izsehzVPBviAa3gvOF/C6l62Rpbkrzv5\nSwIDAQAB\n-----END PUBLIC KEY-----";

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

  it("tolerates surrounding whitespace inside the literal — the YAML block scalar's trailing newline", () => {
    // release.yml passes the key via a `|` block scalar, so the env value (and thus the baked
    // literal) ends with \n — createPublicKey accepts surrounding whitespace, so must the guard.
    expect(isKeyBaked(`var k = ${JSON.stringify(ED + "\n")};`, ED)).toBe(true);
    expect(isKeyBaked(`var k = ${JSON.stringify("\n" + ED + "\n")};`, ED)).toBe(true);
  });

  it("rejects a polluted literal — junk inside the delimiters means createPublicKey would fail", () => {
    // The PEM subsequence is PRESENT, but the runtime string is "junk-----BEGIN…" — unloadable.
    expect(isKeyBaked(`var k = ${JSON.stringify("junk" + ED)};`, ED)).toBe(false);
    expect(isKeyBaked(`var k = ${JSON.stringify(ED + "trailing")};`, ED)).toBe(false);
  });

  it("rejects a missing or degenerate key body", () => {
    expect(isKeyBaked("anything", "")).toBe(false);
    expect(isKeyBaked("anything", "-----BEGIN PUBLIC KEY-----\n-----END PUBLIC KEY-----")).toBe(false);
  });

  it("rejects a configured value that isn't a loadable public key, even when baked verbatim", () => {
    // The guard must validate the KEY, not just the string plumbing: a garbage env value baked
    // perfectly between delimiters still ships a trust root createPublicKey rejects at runtime.
    const garbage = "not-a-public-key-with-more-than-forty-characters-of-payload";
    expect(isKeyBaked(`var k = ${JSON.stringify(garbage)};`, garbage)).toBe(false);
    const fakePem = "-----BEGIN PUBLIC KEY-----\nAAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHIIIIJJJJKKKK\n-----END PUBLIC KEY-----";
    expect(isKeyBaked(`var k = ${JSON.stringify(fakePem)};`, fakePem)).toBe(false);
  });
});
