// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the SHARED editor-control suite (@inplan/renderer/e2e) against the ELECTRON desktop host, plus
// the desktop-only controls below. Uses the repo's standard Electron harness (e2e/helpers.ts) to
// launch the real app on a seeded plan and force-quit past the quit dialog — consistent with the
// other Electron specs. DEFAULT_DOC already embeds a doc-level agent question, so the shared
// QuestionChips spec needs no relaunch. Archived / parked-proposal / active-doc-cap are cloud
// concepts the desktop doesn't have, so those hooks are omitted (the shared specs skip them). Needs a
// real GUI — run locally: `npm run build && npm run test:e2e`.

import { expect, test, type Page } from "@playwright/test";
import { launch, quit, type Ctx } from "./helpers";
import { registerEditorControlSpecs, type EditorHarness } from "@inplan/renderer/e2e";

let ctx: Ctx;
let win: Page;

test.beforeAll(async () => {
  ctx = await launch(); // DEFAULT_DOC: heading + paragraphs + list + an anchored question thread
  win = ctx.win;
});
test.afterAll(async () => {
  await quit(ctx?.app);
});

const harness: EditorHarness = {
  host: "electron",
  caps: {
    backButton: "none", // desktop leaves via the OS window control (→ quit dialog), not a toolbar Back
    agentIndicator: false, // local-first desktop has no presence-aware cloud indicator by default
    draftPrompt: false,
    telemetry: true,
    agentMode: true,
    replayTutorial: true,
    agentConnected: false, // no agent attached in the harness → finish-turn disabled
  },
  openEditor: async () => win,
  openWithQuestion: async () => win, // DEFAULT_DOC already carries a doc-level question
  // openArchived / openWithProposal / atActiveDocCap omitted — not desktop concepts.
};

registerEditorControlSpecs(harness, { test, expect });

// ---- Desktop-only controls (not in the shared module) ----------------------------------------
test.describe("desktop-only controls", () => {
  test("ProfileMenu exposes the telemetry, keep-planning, and replay-tutorial controls", async () => {
    await win.locator(".ap-avatar").click();
    await expect(win.getByText("Share anonymous data")).toBeVisible();
    await expect(win.getByText("Keep agent in planning")).toBeVisible();
    await expect(win.getByText("Replay tutorial")).toBeVisible();
    await win.keyboard.press("Escape");
  });

  test("telemetry + keep-planning toggles flip and revert (self-clean)", async () => {
    await win.locator(".ap-avatar").click();
    const tel = win.getByText("Share anonymous data");
    await tel.click();
    await tel.click();
    const keep = win.getByText("Keep agent in planning");
    await keep.click();
    await keep.click();
    await win.keyboard.press("Escape");
  });
  // The window-close → quit-confirmation flow (incl. the build-mode toggle) is covered by quit.spec.ts.
});
