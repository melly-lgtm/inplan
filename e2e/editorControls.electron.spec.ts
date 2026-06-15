// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the SHARED editor-control suite (@inplan/renderer/e2e) against the ELECTRON desktop host, plus
// the desktop-only controls below. One app instance is launched on a seeded plan file and reused; the
// shared specs are non-destructive / self-cleaning so reuse is safe. The seeded doc embeds a doc-level
// agent question so the shared QuestionChips spec needs no relaunch. Archived / parked-proposal /
// active-doc-cap are cloud concepts the desktop doesn't have, so those hooks are omitted (the shared
// specs skip them). Needs a real GUI — run locally: `npm run build && npm run test:e2e`.

import { _electron as electron, expect, test, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerEditorControlSpecs, type EditorHarness } from "@inplan/renderer/e2e";

const REPO = process.cwd();
let app: ElectronApplication;
let win: Page;

const QUESTION = JSON.stringify([
  { id: "cmt-qst001", anchor: "doc", author: "Agent <agent@inplan>", date: "2026-06-01T00:00:00Z", resolved: false, text: "Pick a fruit?", question: { multiSelect: false, choices: [{ label: "Apple", description: "a" }, { label: "Banana", description: "b" }] } },
]);
const SEED_DOC = `# E2E Plan\n\nalpha beta gamma — a paragraph to select and comment on.\n\nSecond paragraph here.\n\n<!--inplan v1\n${QUESTION}\n-->\n`;

test.beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "inplan-e2e-"));
  const doc = join(dir, "design.plan.md");
  writeFileSync(doc, SEED_DOC);
  app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "userdata")}`, join(REPO, "packages/app"), doc],
    executablePath: join(REPO, "node_modules/.bin/electron"),
    env: { ...process.env, INPLAN_HOME: join(dir, "home"), INPLAN_SIDECAR_DIR: join(dir, "sidecars") },
  });
  win = await app.firstWindow();
  // First launch shows the onboarding tour over a sample doc; skip it to reach the real document.
  await expect(win.locator("body")).toContainText("Welcome to inplan", { timeout: 15_000 });
  const skip = win.getByRole("button", { name: /skip tutorial/i });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(win.locator("body")).toContainText("a paragraph to select", { timeout: 15_000 });
});

test.afterAll(async () => {
  // The window-close is intercepted by the quit-confirmation flow, so app.close() would hang; force-exit.
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
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
    agentConnected: false, // no agent attached in the smoke harness → finish-turn disabled
  },
  openEditor: async () => win,
  openWithQuestion: async () => win, // the seeded doc already carries a doc-level question
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
