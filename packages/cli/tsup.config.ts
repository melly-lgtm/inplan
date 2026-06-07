// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineConfig } from "tsup";

// Bake the PostHog ingest key into the CLI bundle ONLY when set at build time (the release
// workflow sets INPLAN_POSTHOG_KEY — a public, write-only key). Without it — local/dev/source
// builds and forks — `process.env.INPLAN_POSTHOG_KEY` stays a runtime lookup, so a developer's
// own env still works and forks never ship our key. Telemetry stays opt-in regardless.
const POSTHOG_KEY = process.env.INPLAN_POSTHOG_KEY;

// Bundle the internal `@inplan/*` workspace packages INTO the CLI output so the published
// `inplan` package has no unpublished `@inplan/*` dependencies. Third-party deps stay
// external (declared in the release package.json, installed by npm at `-g` install time).
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  clean: true,
  noExternal: [/^@inplan\//],
  ...(POSTHOG_KEY ? { define: { "process.env.INPLAN_POSTHOG_KEY": JSON.stringify(POSTHOG_KEY) } } : {}),
});
