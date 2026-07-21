// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "@playwright/test";

// Electron-smoke / renderer-in-browser e2e (real CodeMirror + CSS + layout — the
// surface the happy-dom unit suite can't reach). Kept separate from the vitest
// unit suite (which owns packages/*/test).
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // In CI, retry twice: a pass-on-retry marks the spec flaky (vs a genuine, repeatable failure that
  // still reds the run), so the nightly stops crying wolf over transient headless-xvfb hiccups while
  // real regressions stay visible. Local runs don't retry (fail fast while iterating).
  retries: process.env.CI ? 2 : 0,
  reporter: [["list"]],
  // Capture artifacts on failure. NB: these `use` options only auto-apply to Playwright's own
  // page/context fixtures; the Electron specs launch the app manually, so their trace is started
  // explicitly in e2e/helpers.ts (config `use.trace` can't reach a hand-launched Electron app).
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
