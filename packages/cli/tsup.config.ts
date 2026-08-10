// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "tsup";

// Bake the PostHog ingest key into the CLI bundle ONLY when set at build time (the release
// workflow sets INPLAN_POSTHOG_KEY — a public, write-only key). Without it — local/dev/source
// builds and forks — `process.env.INPLAN_POSTHOG_KEY` stays a runtime lookup, so a developer's
// own env still works and forks never ship our key. Telemetry stays opt-in regardless.
const POSTHOG_KEY = process.env.INPLAN_POSTHOG_KEY;

// Bake the plugin trust-root PUBLIC key (SPKI PEM) into the bundle the same way. `@inplan/core`'s
// pluginLoader reads `process.env.INPLAN_PLUGIN_PUBLIC_KEY` to verify the entitlement lease + the
// fetched plugin bundle; unless we inline it here, the published CLI ships an EMPTY key and the
// live-collab gate fails closed for EVERY user (the 0.1.27 regression — the desktop app baked it via
// electron.vite.config, but the CLI never did). Skipped on dev/source/fork builds → runtime lookup,
// so a developer's own env still works and forks never ship our key.
const PLUGIN_PUBLIC_KEY = process.env.INPLAN_PLUGIN_PUBLIC_KEY;

// The release sets INPLAN_REQUIRE_PLUGIN_KEY=1 so a forgotten key is a HARD build failure instead of
// silently shipping a CLI with no plugin trust root (mirrors packages/app/electron.vite.config.ts).
if (process.env.INPLAN_REQUIRE_PLUGIN_KEY && !PLUGIN_PUBLIC_KEY) {
  throw new Error(
    "INPLAN_REQUIRE_PLUGIN_KEY is set but INPLAN_PLUGIN_PUBLIC_KEY is missing — refusing to build a CLI without the plugin verifier key.",
  );
}

const define: Record<string, string> = {};
if (POSTHOG_KEY) define["process.env.INPLAN_POSTHOG_KEY"] = JSON.stringify(POSTHOG_KEY);
if (PLUGIN_PUBLIC_KEY) define["process.env.INPLAN_PLUGIN_PUBLIC_KEY"] = JSON.stringify(PLUGIN_PUBLIC_KEY);

// Bundle the internal `@inplan/*` workspace packages INTO the CLI output so the published
// `inplan` package has no unpublished `@inplan/*` dependencies. Third-party deps stay
// external (declared in the release package.json, installed by npm at `-g` install time).
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  noExternal: [/^@inplan\//],
  ...(Object.keys(define).length ? { define } : {}),
});
