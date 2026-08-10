// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helper for the release regression guard (scripts/build-release.mjs): confirm the plugin
// verifier PUBLIC key was actually BAKED into the built CLI bundle, not left as an empty runtime
// `process.env.INPLAN_PLUGIN_PUBLIC_KEY` lookup — the 0.1.27 bug that failed the live-collab gate
// closed for every user. Dependency-free so packages/cli/test/bakedKey.test.ts can unit-test it.

/** The base64 body lines of an SPKI PEM — header/footer and blank lines removed. */
export function spkiBodyLines(pem) {
  return String(pem ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("-----"));
}

/**
 * True iff the COMPLETE key is baked into `bundleSrc`: EVERY base64 line of the SPKI body appears
 * verbatim. Checking every line — not just the first contiguous run — means a truncated or
 * line-1-only bake (e.g. a multi-line RSA key) fails the guard, so the release never approves a CLI
 * whose baked key cannot verify plugins. A missing/degenerate key body is likewise rejected.
 */
export function isKeyBaked(bundleSrc, pem) {
  const lines = spkiBodyLines(pem);
  if (lines.join("").length < 40) return false; // no/degenerate key → not a real trust root
  return lines.every((line) => bundleSrc.includes(line));
}
