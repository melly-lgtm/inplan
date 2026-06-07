// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for the agent resolve-suggestion (`may_resolve`): the agent flags its last reply
// `may_resolve` and the app — driven by the auto-resolve setting — either shows an
// "Agent suggested to resolve" badge (off) or resolves the thread on load (on). The
// on-path also guards the undo regression: undoing an auto-resolution must stick (the
// effect must not immediately re-resolve it, which would clear redo).
//
// Drives the REAL Electron app (real rail rendering + keyboard undo) — the surface the
// happy-dom unit suite can't reach. Hermetic via a throwaway INPLAN_HOME: the onboarding
// flag and global settings both live there, so each launch starts from a known state.
import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();

// A thread whose LAST comment (the agent's reply) carries may_resolve.
const DOC_SUGGESTED =
  "# Plan\n\nUse [Postgres](#cmt-root1) for storage.\n\n<!--inplan v1\n" +
  JSON.stringify([
    { id: "cmt-root1", author: "You", date: "2026-01-01T00:00:01Z", resolved: false, text: "Which datastore?" },
    { id: "cmt-rep01", parentId: "cmt-root1", author: "Opus <claude@inplan.ai>", date: "2026-01-01T00:00:02Z", resolved: false, text: "Adopted Postgres.", may_resolve: true },
  ]) +
  "\n-->\n";

/** Launch the real app on a may_resolve doc with `autoResolve` preset, past the tour. */
async function launch(autoResolve: boolean): Promise<{ app: ElectronApplication; win: Page }> {
  const dir = mkdtempSync(join(tmpdir(), "inplan-mayresolve-"));
  const home = join(dir, "home");
  mkdirSync(home, { recursive: true });
  // Skip the first-run tour and preset the setting — both read from $INPLAN_HOME.
  writeFileSync(join(home, "state.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ autoResolve, agentMode: "planning", telemetry: false }));
  const doc = join(dir, "design.plan.md");
  writeFileSync(doc, DOC_SUGGESTED);
  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "userdata")}`, join(REPO, "packages/app"), doc],
    executablePath: join(REPO, "node_modules/.bin/electron"),
    env: { ...process.env, INPLAN_HOME: home, INPLAN_SIDECAR_DIR: join(dir, "sidecars") },
  });
  const win = await app.firstWindow();
  await expect(win.locator("body")).toContainText("Use Postgres for storage", { timeout: 15_000 });
  return { app, win };
}

async function quit(app?: ElectronApplication): Promise<void> {
  // Window-close is intercepted by the quit-confirmation flow, so app.close() would hang.
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}

test.describe("may_resolve — auto-resolve OFF: badge", () => {
  let app: ElectronApplication;
  let win: Page;
  test.beforeAll(async () => ({ app, win } = await launch(false)));
  test.afterAll(() => quit(app));

  test("shows the 'Agent suggested to resolve' badge on the open thread", async () => {
    await expect(win.locator(".ap-suggested-badge")).toBeVisible({ timeout: 10_000 });
    await expect(win.locator(".ap-suggested-badge")).toContainText(/agent suggested to resolve/i);
    // The thread is still open (its comment is in the rail).
    await expect(win.locator(".ap-rail")).toContainText("Which datastore?");
  });
});

test.describe("may_resolve — auto-resolve ON: resolves + undo sticks", () => {
  let app: ElectronApplication;
  let win: Page;
  test.beforeAll(async () => ({ app, win } = await launch(true)));
  test.afterAll(() => quit(app));

  test("resolves the suggested thread on load (leaves the rail, no badge)", async () => {
    // Resolved → the thread leaves the open rail and the badge never shows.
    await expect(win.locator(".ap-rail")).not.toContainText("Which datastore?", { timeout: 10_000 });
    await expect(win.locator(".ap-suggested-badge")).toHaveCount(0);
  });

  test("undo brings the thread back and does NOT re-resolve it; redo re-resolves", async () => {
    // Undo the auto-resolution → the thread comes back...
    await win.locator("body").press("ControlOrMeta+z");
    await expect(win.locator(".ap-rail")).toContainText("Which datastore?", { timeout: 10_000 });
    // ...and STAYS back: the effect must not immediately re-resolve it (the regression).
    await win.waitForTimeout(500);
    await expect(win.locator(".ap-rail")).toContainText("Which datastore?");
    // Redo still works (it wasn't lost) → the thread resolves again and leaves the rail.
    await win.locator("body").press("ControlOrMeta+Shift+z");
    await expect(win.locator(".ap-rail")).not.toContainText("Which datastore?", { timeout: 10_000 });
  });
});
