// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for the quit-confirmation flow through the REAL app: closing the window raises the shared
// "Do you want to quit?" dialog (instead of quitting outright); the optional Save box appears only
// when there are unsaved edits; the "Switch agent to build mode" box closes the session as
// "completed" (the agent hand-off) while a plain quit closes as "window_closed"; and Cancel keeps
// the app open. Effects confirmed via the control log's session_closed event.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launch, quit, setPanes, waitForEvent, readLog, type Ctx } from "./helpers";

let ctx: Ctx;
let app: ElectronApplication;
let win: Page;

test.beforeEach(async () => {
  ctx = await launch();
  app = ctx.app;
  win = ctx.win;
});
test.afterEach(() => quit(app));

/** Ask the OS window to close (red X / Cmd+W), which the main process turns into a confirm-quit
 *  request to the renderer rather than quitting — exactly the real close path. */
async function requestClose(): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
}

/** Make an unsaved body edit so the dialog's Save box is offered. */
async function makeDirty(): Promise<void> {
  await setPanes(win, 3);
  const cm = win.locator(".cm-content");
  await cm.click();
  await win.keyboard.press("ControlOrMeta+End");
  await win.keyboard.type("\n\nunsaved edit\n");
}

test("closing with no unsaved changes raises the dialog WITHOUT a Save box; plain quit closes as window_closed", async () => {
  await requestClose();
  await expect(win.locator(".ap-quit")).toBeVisible({ timeout: 5_000 });
  // No edits → no Save checkbox; only the build-mode toggle is offered.
  await expect(win.getByText(/^Save /)).toHaveCount(0);
  await win.getByRole("button", { name: /^quit$/i }).click();
  const ev = await waitForEvent(ctx, "session_closed");
  expect((ev.payload as { reason?: string }).reason).toBe("window_closed");
});

test("closing with unsaved changes offers a Save box; 'build mode' closes as completed", async () => {
  await makeDirty();
  await requestClose();
  await expect(win.locator(".ap-quit")).toBeVisible({ timeout: 5_000 });
  // The Save box appears (dirty) and is checked by default.
  const saveBox = win.locator(".ap-quit-opt", { hasText: /^Save / }).locator("input[type=checkbox]");
  await expect(saveBox).toBeChecked();
  // Tick "Switch agent to build mode" → the session closes as the completed hand-off.
  await win.getByText(/switch agent to build mode/i).click();
  await win.getByRole("button", { name: /^quit$/i }).click();
  const ev = await waitForEvent(ctx, "session_closed");
  expect((ev.payload as { reason?: string }).reason).toBe("completed");
});

test("Cancel dismisses the dialog and keeps the app open", async () => {
  await requestClose();
  await expect(win.locator(".ap-quit")).toBeVisible({ timeout: 5_000 });
  await win.getByRole("button", { name: /^cancel$/i }).click();
  await expect(win.locator(".ap-quit")).toHaveCount(0);
  // Still alive: no session_closed was logged, and the editor still responds.
  expect(readLog(ctx).some((e) => e.type === "session_closed")).toBe(false);
  await expect(win.locator(".ap-rendered")).toContainText("alpha");
});
