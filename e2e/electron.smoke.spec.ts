// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Electron-smoke e2e: drives the REAL app (real CodeMirror, real CSS Custom
// Highlight API, real layout) — the surface the happy-dom unit suite can't reach.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();
let app: ElectronApplication;
let win: Page;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "inplan-e2e-"));
  const doc = join(dir, "design.plan.md");
  writeFileSync(doc, "# E2E Plan\n\nalpha beta alpha gamma alpha\n\nSecond paragraph here.\n\n<!--inplan v1\n[]\n-->\n");
  app = await electron.launch({
    // Fresh user-data-dir so localStorage is empty → the first-run onboarding deterministically shows.
    args: [`--user-data-dir=${join(dir, "userdata")}`, join(REPO, "packages/app"), doc],
    executablePath: join(REPO, "node_modules/.bin/electron"),
    env: { ...process.env, INPLAN_SIDECAR_DIR: join(dir, "sidecars") },
  });
  win = await app.firstWindow();
  // First launch shows the onboarding tour over a throwaway sample; skip it to reach the
  // agent's real document (also exercises the tour → real-file handoff).
  await expect(win.locator("body")).toContainText("Welcome to inplan", { timeout: 15_000 });
  const skip = win.getByRole("button", { name: /skip tutorial/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(win.locator("body")).toContainText("alpha beta alpha", { timeout: 15_000 });
});

test.afterAll(async () => {
  // The window-close is intercepted by the quit-confirmation flow, so a graceful
  // app.close() would hang waiting for the dialog. Force-exit the main process instead.
  await app?.evaluate(({ app: electronApp }) => electronApp.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
});

test("renders the loaded plan in the preview", async () => {
  await expect(win.locator("body")).toContainText("E2E Plan");
  await expect(win.locator("body")).toContainText("Second paragraph here.");
});

test("find registers a real CSS Custom Highlight (happy-dom can't)", async () => {
  // ControlOrMeta maps to Cmd on macOS and Ctrl elsewhere; the app's find handler
  // accepts either, so this opens the find bar on every CI platform.
  await win.locator("body").press("ControlOrMeta+f");
  const input = win.locator("#ap-find-input");
  await expect(input).toBeVisible();
  await input.fill("alpha");
  // The find effect calls CSS.highlights.set("ap-find", ...) — only runs in a real browser.
  await expect
    .poll(async () => win.evaluate(() => (globalThis as unknown as { CSS?: { highlights?: { has(k: string): boolean } } }).CSS?.highlights?.has("ap-find") ?? false), { timeout: 5_000 })
    .toBe(true);
});

test("the real CodeMirror source editor mounts in 3-pane", async () => {
  await win.getByTitle("3 panes").click();
  await expect(win.locator(".cm-editor")).toBeVisible({ timeout: 5_000 });
});
