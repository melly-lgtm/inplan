// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { verifyLease, verifyBundleBytes, type LeaseClaims, type BundleManifestEntry } from "../src/collabLoader";

const kp = () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { pub: publicKey.export({ type: "spki", format: "pem" }).toString(), priv: privateKey };
};
const { pub, priv } = kp();

// Mint a lease exactly as the collab server's signLease does: base64url(payload).base64url(sig).
function mintLease(claims: LeaseClaims): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const s = sign(null, Buffer.from(body), priv).toString("base64url");
  return `${body}.${s}`;
}
const claims = (over: Partial<LeaseClaims> = {}): LeaseClaims => ({ sub: "u1", plan: "pro", features: ["instant"], iat: 1000, exp: 9_999_999_999_999, ...over });

describe("verifyLease", () => {
  it("accepts a valid, unexpired lease and returns its claims", () => {
    const got = verifyLease(mintLease(claims()), pub, 2000);
    expect(got).toMatchObject({ sub: "u1", plan: "pro", features: ["instant"] });
  });
  it("rejects an expired lease (exp <= now)", () => {
    expect(verifyLease(mintLease(claims({ exp: 5000 })), pub, 6000)).toBeNull();
  });
  it("rejects a tampered payload (re-encoded claims, original sig)", () => {
    const token = mintLease(claims());
    const sig = token.slice(token.indexOf(".") + 1);
    const forged = Buffer.from(JSON.stringify(claims({ plan: "enterprise" }))).toString("base64url") + "." + sig;
    expect(verifyLease(forged, pub, 2000)).toBeNull();
  });
  it("rejects a lease signed by a different key", () => {
    const other = kp();
    const body = Buffer.from(JSON.stringify(claims())).toString("base64url");
    const badSig = sign(null, Buffer.from(body), other.priv).toString("base64url");
    expect(verifyLease(`${body}.${badSig}`, pub, 2000)).toBeNull();
  });
  it("fail-closed: empty public key, malformed token, or no key all return null", () => {
    expect(verifyLease(mintLease(claims()), "", 2000)).toBeNull();
    expect(verifyLease("garbage", pub, 2000)).toBeNull();
    expect(verifyLease("", pub, 2000)).toBeNull();
  });
  it("rejects a validly-signed but malformed payload (missing required claims)", () => {
    // A real signature over a payload that lacks sub/plan/features/iat — must not pass as claims.
    const body = Buffer.from(JSON.stringify({ exp: 9_999_999_999_999 })).toString("base64url");
    const s = sign(null, Buffer.from(body), priv).toString("base64url");
    expect(verifyLease(`${body}.${s}`, pub, 2000)).toBeNull();
  });
  it("rejects a signed payload with wrong-typed claims (features not an array)", () => {
    const body = Buffer.from(JSON.stringify({ sub: "u", plan: "pro", features: "instant", iat: 1, exp: 9_999_999_999_999 })).toString("base64url");
    const s = sign(null, Buffer.from(body), priv).toString("base64url");
    expect(verifyLease(`${body}.${s}`, pub, 2000)).toBeNull();
  });
});

describe("verifyBundleBytes", () => {
  const entryFor = (bytes: Buffer): BundleManifestEntry => ({
    name: "desktop.js",
    sha384: createHash("sha384").update(bytes).digest("base64"),
    sig: sign(null, bytes, priv).toString("base64"),
  });

  it("accepts bytes matching both sha384 and signature", () => {
    const bytes = Buffer.from("export const ok = 1;\n");
    expect(verifyBundleBytes(bytes, entryFor(bytes), pub)).toBe(true);
  });
  it("rejects when the bytes don't match the sha384 (tampered file)", () => {
    const entry = entryFor(Buffer.from("original"));
    expect(verifyBundleBytes(Buffer.from("tampered"), entry, pub)).toBe(false);
  });
  it("rejects a valid hash but a signature from a different key", () => {
    const bytes = Buffer.from("payload");
    const other = kp();
    const entry: BundleManifestEntry = {
      name: "x",
      sha384: createHash("sha384").update(bytes).digest("base64"),
      sig: sign(null, bytes, other.priv).toString("base64"),
    };
    expect(verifyBundleBytes(bytes, entry, pub)).toBe(false);
  });
  it("fail-closed: no public key ⇒ false", () => {
    const bytes = Buffer.from("x");
    expect(verifyBundleBytes(bytes, entryFor(bytes), "")).toBe(false);
  });
});
