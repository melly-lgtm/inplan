// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for Create Doc / Move Blocks to New Doc through the REAL app: the right-click context menu →
// modal → the selection becomes a link, blocks move with format preserved, and an existing target
// surfaces the link/append options instead of silently failing. Effects confirmed via the control
// log + the on-disk doc.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { launch, quit, waitForEvent, type Ctx } from "./helpers";

let ctx: Ctx;
let app: ElectronApplication;
let win: Page;

test.beforeEach(async () => {
  ctx = await launch();
  app = ctx.app;
  win = ctx.win;
});
test.afterEach(() => quit(app));

/** Select a preview block's text and open the right-click context menu on it. */
async function selectAndContext(text: string): Promise<void> {
  await win.getByText(text, { exact: false }).first().selectText();
  await win.getByText(text, { exact: false }).first().click({ button: "right" });
}

test("the move action is labelled 'Move Blocks to New Doc' (it moves whole blocks)", async () => {
  await selectAndContext("second list item");
  await expect(win.getByRole("menuitem", { name: /move blocks to new doc/i })).toBeVisible();
});

test("Create Doc links the selection in place to a new file", async () => {
  await selectAndContext("Second paragraph, separated by a blank line.");
  await win.getByRole("menuitem", { name: /create doc/i }).click();
  await win.getByRole("textbox", { name: /file location/i }).fill("section.md");
  await win.getByRole("button", { name: /^create$/i }).click();
  await waitForEvent(ctx, "doc_created");
  await expect.poll(() => readFileSync(ctx.docPath, "utf8").includes("](section.md)"), { timeout: 5_000 }).toBe(true);
});

test("Move Blocks keeps a moved list item a list item (format-preserving link)", async () => {
  await selectAndContext("second list item");
  await win.getByRole("menuitem", { name: /move blocks to new doc/i }).click();
  await win.getByRole("textbox", { name: /file location/i }).fill("beta.md");
  await win.getByRole("button", { name: /^move$/i }).click();
  await waitForEvent(ctx, "text_moved");
  // The list item is replaced by a link that KEEPS its "- " marker; the other items survive.
  await expect.poll(() => readFileSync(ctx.docPath, "utf8"), { timeout: 5_000 }).toMatch(/- \[[^\]]+\]\(beta\.md\)/);
  const body = readFileSync(ctx.docPath, "utf8");
  expect(body).toContain("- first list item");
  expect(body).toContain("- third list item");
});

test("Move onto an existing file warns + offers Append (default) instead of failing silently", async () => {
  // Seed a sibling file so the target already exists.
  await quit(app);
  ctx = await launch({ files: { "exists.md": "# Existing\n\noriginal.\n\n<!--inplan v1\n[]\n-->\n" } });
  app = ctx.app;
  win = ctx.win;
  await selectAndContext("second list item");
  await win.getByRole("menuitem", { name: /move blocks to new doc/i }).click();
  await win.getByRole("textbox", { name: /file location/i }).fill("exists.md");
  await win.getByRole("button", { name: /^move$/i }).click();
  // The modal now warns and shows the Append (default-checked) action rather than closing.
  // (`setStatus` mirrors the same text into the status bar, so scope to the modal's warning.)
  await expect(win.locator(".ap-newdoc-warn")).toBeVisible();
  await win.getByRole("button", { name: /^append$/i }).click();
  await waitForEvent(ctx, "text_moved");
  await expect.poll(() => readFileSync(ctx.dir + "/exists.md", "utf8").includes("second list item"), { timeout: 5_000 }).toBe(true);
});
