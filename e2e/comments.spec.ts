// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for the comment system through the REAL app: answering a question thread, replying, resolving,
// and creating a doc-level + an anchored span comment. UI actions are driven via Playwright; effects
// are confirmed against the control log (the app's ground-truth record) for robustness.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
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

test("the question thread renders and answering it records the selection", async () => {
  // The seed doc has an anchored question (cmt-q1) with Postgres / SQLite choices.
  await expect(win.getByText("Which datastore?")).toBeVisible();
  await win.getByText("Postgres", { exact: false }).first().click(); // pick the radio
  await win.getByRole("button", { name: "Answer" }).click();
  const ev = await waitForEvent(ctx, "comment_answered");
  expect((ev.payload as { selected?: string[] }).selected).toEqual(["Postgres"]);
});

test("replying to a thread records a comment_created reply", async () => {
  await win.getByRole("button", { name: /^reply$/i }).first().click();
  const box = win.locator(".ap-reply-box textarea");
  await box.fill("Let's go with Postgres.");
  await box.press("ControlOrMeta+Enter"); // the reply box submits on Cmd/Ctrl+Enter
  const ev = await waitForEvent(ctx, "comment_created");
  expect((ev.payload as { parentId?: string }).parentId).toBe("cmt-q1");
});

test("resolving a thread records comment_resolved and clears it from the open rail", async () => {
  await win.getByRole("button", { name: /resolve thread/i }).first().click();
  const ev = await waitForEvent(ctx, "comment_resolved");
  expect((ev.payload as { resolved?: boolean }).resolved).toBe(true);
  // …and the resolved thread leaves the open rail (no resolve affordance remains).
  await expect(win.getByRole("button", { name: /resolve thread/i })).toHaveCount(0);
});

test("Comment on Doc creates a doc-level comment", async () => {
  // With no selection the toolbar's add-comment affordance targets the whole doc.
  await win.getByRole("button", { name: "Comment on Doc" }).click();
  await win.locator("textarea").last().fill("Overall this looks solid.");
  await win.getByRole("button", { name: /comment|add|post|send/i }).last().click().catch(() => {});
  await win.locator("textarea").last().press("Control+Enter").catch(() => {});
  const ev = await waitForEvent(ctx, "comment_created");
  expect(ev.actor).toBe("user");
});

test("Comment on Text anchors a comment to the selected span", async () => {
  await win.getByText("Second paragraph, separated by a blank line.").selectText();
  await win.getByRole("button", { name: "Comment on Text" }).click();
  await win.locator("textarea").last().fill("Anchored note.");
  await win.locator("textarea").last().press("Control+Enter").catch(() => {});
  await win.getByRole("button", { name: /comment|add|post|send/i }).last().click().catch(() => {});
  const ev = await waitForEvent(ctx, "comment_created");
  // The anchoring actually happened: the selected span is now an in-body `[..](#cmt-<id>)`
  // link, tagged `data-cmt` in the rendered preview (the seed's cmt-q1 is the only other one).
  const id = (ev.payload as { id?: string }).id;
  expect(id).toBeTruthy();
  await expect(win.locator(`.ap-rendered a[data-cmt="${id}"]`)).toBeVisible({ timeout: 5_000 });
});
