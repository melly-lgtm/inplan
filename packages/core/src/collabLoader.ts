// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The trust core for the (paid, proprietary) live-collaboration plugin the desktop loads at
// runtime. Open-core ships ONLY these pure verifiers + the baked-in public key — never the plugin
// code itself. The app main and the CLI MUST call these before importing any fetched bundle file:
//
//   verifyLease(token)         → the entitlement lease's claims, iff the Ed25519 signature matches
//                                the baked-in public key AND it hasn't expired (offline grace).
//   verifyBundleBytes(b, e)    → true iff a fetched bundle file's bytes match the manifest entry's
//                                sha384 AND Ed25519 signature.
//
// Both fail-closed (return null/false) on any error — a tampered/forged/expired input can never be
// treated as trusted, so unverified code is never executed.
//
// fs-free + network-free: import from `@inplan/core/node` (uses node:crypto). The matching private
// key signs leases (server) + the bundle (release); rotating it means shipping a new app build.

import { createHash, createPublicKey, verify } from "node:crypto";

/** The inplan signing public key (Ed25519, SPKI PEM). Baked at build time (the release injects it,
 *  like the telemetry key); overridable via env for dev / self-host. Empty ⇒ nothing verifies, so
 *  the desktop stays turn-only (fail-closed). */
export const COLLAB_PUBLIC_KEY: string = process.env.INPLAN_COLLAB_PUBLIC_KEY ?? "";

export interface LeaseClaims {
  sub: string;
  plan: string;
  features: string[];
  iat: number;
  exp: number;
}

/** Verify + decode a desktop-collab lease (`base64url(payload).base64url(ed25519sig)` — the format
 *  the collab server's signLease emits). Returns the claims iff the signature matches the public
 *  key AND `exp` is in the future; otherwise null. Never throws. */
export function verifyLease(token: string, publicKeyPem: string = COLLAB_PUBLIC_KEY, now: number = Date.now()): LeaseClaims | null {
  try {
    if (!publicKeyPem || typeof token !== "string") return null;
    const dot = token.indexOf(".");
    if (dot <= 0) return null;
    const body = token.slice(0, dot);
    const sig = token.slice(dot + 1);
    if (!verify(null, Buffer.from(body), createPublicKey(publicKeyPem), Buffer.from(sig, "base64url"))) return null;
    const claims = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as LeaseClaims;
    // A valid signature only proves authenticity, not shape — validate every claim so callers
    // never read an undefined field off a malformed-but-signed payload. Reject if expired.
    if (
      typeof claims.sub !== "string" ||
      typeof claims.plan !== "string" ||
      !Array.isArray(claims.features) ||
      typeof claims.iat !== "number" ||
      typeof claims.exp !== "number" ||
      claims.exp <= now
    )
      return null;
    return claims;
  } catch {
    return null;
  }
}

export interface BundleManifestEntry {
  name: string;
  /** Base64 SHA-384 of the file bytes. */
  sha384: string;
  /** Base64 Ed25519 signature over the file bytes. */
  sig: string;
}

/** Verify a fetched bundle file's bytes against its manifest entry: BOTH the sha384 integrity hash
 *  and the Ed25519 signature must match the baked-in public key. Returns true iff both pass.
 *  Callers MUST gate `import()` of the file on this returning true. Never throws. */
export function verifyBundleBytes(bytes: Buffer, entry: BundleManifestEntry, publicKeyPem: string = COLLAB_PUBLIC_KEY): boolean {
  try {
    if (!publicKeyPem || !entry) return false;
    if (createHash("sha384").update(bytes).digest("base64") !== entry.sha384) return false;
    return verify(null, bytes, createPublicKey(publicKeyPem), Buffer.from(entry.sig, "base64"));
  } catch {
    return false;
  }
}
