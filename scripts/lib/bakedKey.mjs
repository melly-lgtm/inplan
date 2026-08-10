// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helper for the release regression guard (scripts/build-release.mjs): confirm the plugin
// verifier PUBLIC key was actually BAKED into the built CLI bundle, not left as an empty runtime
// `process.env.INPLAN_PLUGIN_PUBLIC_KEY` lookup — the 0.1.27 bug that failed the live-collab gate
// closed for every user. Dependency-free so packages/cli/test/bakedKey.test.ts can unit-test it.

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every non-empty line of the PEM (header, base64 body, footer), trimmed. */
function pemLines(pem) {
  return String(pem ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/** The base64 body lines of an SPKI PEM — header/footer and blank lines removed. */
export function spkiBodyLines(pem) {
  return pemLines(pem).filter((l) => !l.startsWith("-----"));
}

/**
 * True iff the COMPLETE serialized PEM — header, every base64 body line IN ORDER, footer — appears
 * contiguously in `bundleSrc`, with each newline in either its escaped string-literal form (`\n`
 * as backslash-n, which is what esbuild's `define` emits inside one quoted string) or literal form
 * (a template literal). Requiring the whole serialization in order means out-of-order fragments,
 * coincidental substrings scattered through the bundle, or a truncated bake cannot satisfy the
 * guard — the bundle must contain a string `crypto.createPublicKey` would actually accept. A
 * missing or degenerate key body is likewise rejected.
 */
export function isKeyBaked(bundleSrc, pem) {
  const lines = pemLines(pem);
  if (spkiBodyLines(pem).join("").length < 40) return false; // no/degenerate key → not a real trust root
  const NL = String.raw`(?:(?:\\r)?\\n|\r?\n)`;
  return new RegExp(lines.map(escapeRe).join(NL)).test(String(bundleSrc ?? ""));
}
