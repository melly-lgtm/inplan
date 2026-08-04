// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for the Source pane's formatting toolbar + image insertion (#64), through the REAL app —
// the browser-only behaviours the happy-dom unit suite can't reach: the toolbar's imperative
// commands driving a real CodeMirror, the heading dropdown, and (the high-value one) a picked
// image travelling the WHOLE asset path end to end — `asset:save` writes it next to the doc,
// the CSP allows `file:`, markdown.ts resolves the relative src to a `file://` URL, and the
// preview `<img>` actually loads it (naturalWidth > 0). A regression in any of those links
// fails this test, which the unit tests (pure logic + jsdom, no real image load) can't catch.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launch, quit, setPanes, type Ctx } from "./helpers";

let ctx: Ctx;
let app: ElectronApplication;
let win: Page;

// A valid 1×1 transparent PNG — enough for the browser to decode (naturalWidth becomes 1).
const PNG_1x1 = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

/** Read the CodeMirror source text (the whole doc body as the editor sees it). */
async function source(page: Page): Promise<string> {
  return (await page.locator(".cm-content").textContent()) ?? "";
}

/** Focus the source editor, jump to the end, and type a fresh line — returns with the cursor at the
 *  end of `word` on its own line (no trailing selection). */
async function typeFreshLine(page: Page, word: string): Promise<void> {
  const cm = page.locator(".cm-content");
  await cm.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(`\n${word}`);
}

test.beforeEach(async () => {
  ctx = await launch();
  app = ctx.app;
  win = ctx.win;
  await setPanes(win, 3); // the source pane (CodeMirror + toolbar) only mounts with the source visible
  await expect(win.locator(".ap-src-toolbar")).toBeVisible({ timeout: 5_000 });
});
test.afterEach(() => quit(app));

test("Bold wraps the selected word in the source", async () => {
  await typeFreshLine(win, "BOLDME");
  for (let i = 0; i < "BOLDME".length; i++) await win.keyboard.press("Shift+ArrowLeft"); // select BOLDME
  await win.getByRole("button", { name: "Bold", exact: true }).click();
  await expect.poll(() => source(win)).toContain("**BOLDME**");
});

test("Heading dropdown applies H2 to the cursor's line", async () => {
  await typeFreshLine(win, "MyHeading");
  await win.getByTitle("Heading", { exact: true }).click(); // open the level picker
  await win.getByRole("menuitem", { name: "Heading 2", exact: true }).click();
  await expect.poll(() => source(win)).toContain("## MyHeading");
});

test("Checklist toggles a task marker on and back off", async () => {
  await typeFreshLine(win, "a task");
  const checklist = win.getByRole("button", { name: "Checklist", exact: true });
  await checklist.click();
  await expect.poll(() => source(win)).toContain("- [ ] a task");
  await checklist.click(); // re-toggle strips it (recognizes the "- [ ] " prefix)
  await expect.poll(() => source(win)).not.toContain("- [ ] a task");
});

test("the Image button saves a picked PNG and the preview renders it from a file:// URL", async () => {
  // Drive the hidden <input type=file> the toolbar's Image button clicks — setInputFiles bypasses
  // the OS-native picker while exercising the real onChange → asset:save → insert path.
  await win.locator('input[type="file"]').setInputFiles({ name: "shot.png", mimeType: "image/png", buffer: PNG_1x1 });

  // The insert uses the angle-bracket destination and points at the doc's sibling assets folder.
  await expect.poll(() => source(win), { timeout: 10_000 }).toMatch(/!\[\]\(<[^>]*\.assets\/image-[^>]*\.png>\)/);

  // The whole chain works only if the file was written, the CSP allows file:, markdown.ts rewrote
  // the relative src to file://, and the browser loaded it — assert the rendered <img> has pixels.
  const img = win.locator(".ap-rendered img, .ap-preview img").first();
  await expect(img).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), { timeout: 10_000 }).toBeGreaterThan(0);
});
