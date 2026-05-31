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
  reporter: [["list"]],
});
