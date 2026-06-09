// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for the editing surface through the REAL app: pane layouts, source↔preview, CodeMirror typing
// + undo, find (with a real CSS Custom Highlight), and zoom — the browser-only surface the happy-dom
// unit suite can't exercise.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launch, quit, setPanes, type Ctx } from "./helpers";

let ctx: Ctx;
let app: ElectronApplication;
let win: Page;

test.beforeEach(async () => {
  ctx = await launch();
  app = ctx.app;
  win = ctx.win;
});
test.afterEach(() => quit(app));

test("pane layouts: the real CodeMirror source mounts in 3-pane and hides in 1-pane", async () => {
  await setPanes(win, 3);
  await expect(win.locator(".cm-editor")).toBeVisible({ timeout: 5_000 });
  await setPanes(win, 1);
  await expect(win.locator(".cm-editor")).toHaveCount(0);
});

test("typing in the source editor flows to the preview, and CodeMirror undo reverts it", async () => {
  await setPanes(win, 3);
  const cm = win.locator(".cm-content");
  await cm.click();
  await win.keyboard.press("ControlOrMeta+End"); // jump to end of doc
  await win.keyboard.type("\n\nZZZ-marker-text\n");
  await expect(win.locator(".ap-rendered")).toContainText("ZZZ-marker-text");
  // CodeMirror owns typing undo while the source is focused; it groups typing into several history
  // steps, so undo a few times until the inserted marker is fully reverted.
  await expect
    .poll(
      async () => {
        await win.keyboard.press("ControlOrMeta+z");
        return (await win.locator(".ap-rendered").textContent())?.includes("ZZZ-marker-text") ?? false;
      },
      { timeout: 5_000 },
    )
    .toBe(false);
});

test("find registers a real CSS Custom Highlight (happy-dom can't)", async () => {
  await win.locator("body").press("ControlOrMeta+f");
  const input = win.locator("#ap-find-input");
  await expect(input).toBeVisible();
  await input.fill("alpha");
  await expect
    .poll(() => win.evaluate(() => (globalThis as unknown as { CSS?: { highlights?: { has(k: string): boolean } } }).CSS?.highlights?.has("ap-find") ?? false), { timeout: 5_000 })
    .toBe(true);
});

test("zoom in changes the zoom level off 100%", async () => {
  const zoomVal = win.locator(".ap-zoom-val");
  await expect(zoomVal).toHaveText("100%");
  await win.getByRole("button", { name: "Zoom in" }).click();
  await expect(zoomVal).not.toHaveText("100%");
  await win.getByRole("button", { name: "Reset zoom" }).click();
  await expect(zoomVal).toHaveText("100%");
});
