// SPDX-License-Identifier: AGPL-3.0-or-later
//
// e2e for in-window navigation through the REAL app: following a relative Markdown link to a sibling
// doc, the Back/Forward segment that appears once a link history exists, and — the #71 regression —
// that per-doc undo history SURVIVES leaving and returning to a document. Driven via Playwright;
// effects confirmed against the live preview + the control log.

import { expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { launch, quit, waitForEvent, type Ctx } from "./helpers";

let ctx: Ctx;
let app: ElectronApplication;
let win: Page;

// A doc that links to a sibling .md, plus the sibling itself (distinctive body text to detect the swap).
const LINKING_DOC = "# Home Plan\n\nalpha home marker.\n\nGo to [the section doc](section.md) for details.\n";
const SECTION_DOC = "# Section Doc\n\nSECTION-DOC-MARKER lives here.\n";

test.beforeEach(async () => {
  ctx = await launch({ doc: LINKING_DOC, files: { "section.md": SECTION_DOC }, expectText: "home marker" });
  app = ctx.app;
  win = ctx.win;
});
test.afterEach(() => quit(app));

test("clicking an internal .md link follows it to the sibling doc", async () => {
  await win.getByRole("link", { name: /the section doc/i }).click();
  await expect(win.locator(".ap-rendered")).toContainText("SECTION-DOC-MARKER", { timeout: 5_000 });
  // The source doc's log records the hand-off so its attached agent can step down + re-attach.
  await waitForEvent(ctx, "navigated_to");
});

test("Back/Forward navigates between the two docs once a link history exists", async () => {
  await win.getByRole("link", { name: /the section doc/i }).click();
  await expect(win.locator(".ap-rendered")).toContainText("SECTION-DOC-MARKER", { timeout: 5_000 });

  // The nav segment appears with Back enabled; going Back returns to the home doc.
  const back = win.getByRole("button", { name: /back to previous document/i });
  await expect(back).toBeEnabled({ timeout: 5_000 });
  await back.click();
  await expect(win.locator(".ap-rendered")).toContainText("home marker", { timeout: 5_000 });

  // Forward returns to the section doc.
  const fwd = win.getByRole("button", { name: /forward to next document/i });
  await expect(fwd).toBeEnabled();
  await fwd.click();
  await expect(win.locator(".ap-rendered")).toContainText("SECTION-DOC-MARKER", { timeout: 5_000 });
});

test("per-doc undo history survives navigating away and back (#71)", async () => {
  // Make an app-level history entry on the home doc: add a doc-level comment.
  await win.getByRole("button", { name: "Comment on Doc" }).click();
  await win.locator("textarea").last().fill("A note that undo should be able to revert.");
  await win.locator("textarea").last().press("Control+Enter").catch(() => {});
  await win.getByRole("button", { name: /comment|add|post|send/i }).last().click().catch(() => {});
  await waitForEvent(ctx, "comment_created");
  await expect(win.locator(".ap-rendered")).toContainText("home marker");

  // Leave to the section doc, then come back to the home doc.
  await win.getByRole("link", { name: /the section doc/i }).click();
  await expect(win.locator(".ap-rendered")).toContainText("SECTION-DOC-MARKER", { timeout: 5_000 });
  const back = win.getByRole("button", { name: /back to previous document/i });
  await expect(back).toBeEnabled({ timeout: 5_000 });
  await back.click();
  await expect(win.locator(".ap-rendered")).toContainText("home marker", { timeout: 5_000 });

  // The undo stack was stashed per-doc and restored on return — so Ctrl+Z still has the comment to revert.
  await win.locator("body").press("ControlOrMeta+z");
  await expect(win.locator(".ap-status-msg")).toHaveText(/undid/i, { timeout: 5_000 });
});
