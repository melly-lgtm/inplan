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
 * as an ENTIRE string literal in `bundleSrc`: opened by a quote (", ', or backtick) immediately
 * before the header and closed by the SAME quote immediately after the footer, with each newline
 * in either its escaped string-literal form (`\n` as backslash-n, which is what esbuild's
 * `define` emits) or literal form (a template literal). The delimiter anchoring matters: a
 * polluted bake like "junk-----BEGIN…" still CONTAINS the PEM subsequence, but
 * `crypto.createPublicKey` would reject the runtime value — the guard must only accept a literal
 * that actually loads. Out-of-order fragments, scattered substrings, truncation, and
 * degenerate/missing bodies are all rejected.
 */
export function isKeyBaked(bundleSrc, pem) {
  const lines = pemLines(pem);
  if (spkiBodyLines(pem).join("").length < 40) return false; // no/degenerate key → not a real trust root
  const NL = String.raw`(?:(?:\\r)?\\n|\r?\n)`;
  const DELIM = "([\"'`])";
  return new RegExp(DELIM + lines.map(escapeRe).join(NL) + String.raw`\1`).test(String(bundleSrc ?? ""));
}
