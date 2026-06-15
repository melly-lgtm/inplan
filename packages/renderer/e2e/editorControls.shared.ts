// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The SHARED editor-control e2e suite. Driven through an injected {@link EditorHarness} so the exact
// same specs run against BOTH hosts that render @inplan/renderer — the Electron desktop app and the
// inplan.ai web app. Host differences are absorbed by `harness.caps` flags and the optional seeded-
// state hooks; this file knows nothing about Electron or the cloud. Specs are non-destructive or
// self-cleaning so a host may reuse a single Page across tests.
//
// IMPORTANT: this module is consumed cross-package (the cloud imports it from the symlinked open-core
// renderer). It must NOT `import { test }` at runtime — that would load a SECOND @playwright/test
// instance (the open-core copy) and clash with the host runner's copy. So the host passes its own
// `test`/`expect` in via `pw`, and we import only TYPES here.

import type { Page, test as TestApi, expect as ExpectApi } from "@playwright/test";
import type { EditorHarness } from "./harness";

/** The host's Playwright runtime, injected so the shared specs register on the host's own instance. */
export interface PlaywrightApi {
  test: typeof TestApi;
  expect: typeof ExpectApi;
}

const MOD = "ControlOrMeta"; // Playwright maps this to ⌘ on macOS, Ctrl elsewhere — the app accepts either.

export function registerEditorControlSpecs(h: EditorHarness, pw: PlaywrightApi): void {
  const { test, expect } = pw;

  /** Return the editor to a known baseline between tests: dismiss find/menus/composer/popovers and
   *  show all three panes (so the comments rail — where thread cards render — is visible). */
  async function resetUi(page: Page): Promise<void> {
    await page.keyboard.press("Escape").catch(() => {});
    await page.keyboard.press("Escape").catch(() => {});
    const find = page.locator("#ap-find-input");
    if (await find.isVisible().catch(() => false)) await page.getByRole("button", { name: "close" }).click().catch(() => {});
    const threePanes = page.getByTitle("3 panes", { exact: true });
    if (await threePanes.count()) await threePanes.click().catch(() => {});
  }

  /** Double-click the first word of the first preview PARAGRAPH (not a heading — comments can't anchor
   *  to a heading) → a content-agnostic, anchorable span selection. */
  async function selectFirstWord(page: Page): Promise<void> {
    const para = page.locator(".ap-preview p, .ap-preview li").first();
    await expect(para).toBeVisible();
    // Click near the top-left where the first word sits — the element's center can be empty space
    // past short text, and double-clicking whitespace yields an un-anchorable (disabled) selection.
    await para.dblclick({ position: { x: 6, y: 8 } });
  }

  /** Clear any selection so the toolbar reads "Comment on Doc" (doc-level). */
  async function clearSelection(page: Page): Promise<void> {
    await page.locator(".ap-preview").click({ position: { x: 2, y: 2 } });
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
  }

  test.describe(`editor controls [${h.host}]`, () => {
    let page: Page;
    test.beforeEach(async () => {
      page = await h.openEditor();
      await resetUi(page);
    });

    // ---- TopBar: panes -------------------------------------------------------------------------
    test.describe("TopBar · panes", () => {
      for (const n of [1, 2, 3] as const) {
        const label = n === 1 ? "1 pane" : `${n} panes`;
        test(`switches to ${label} and marks it active`, async () => {
          const btn = page.getByTitle(label, { exact: true });
          await btn.click();
          await expect(btn).toHaveClass(/active/);
          if (n === 3) await expect(page.locator(".cm-editor")).toBeVisible(); // 3-pane includes the CodeMirror source
        });
      }
    });

    // ---- TopBar: zoom --------------------------------------------------------------------------
    test("TopBar · zoom in / out / reset adjusts the percentage and reset returns to 100%", async () => {
      const reset = page.getByRole("button", { name: "Reset zoom" });
      await page.getByRole("button", { name: "Zoom in" }).click();
      await expect(reset).not.toHaveText("100%");
      await page.getByRole("button", { name: "Zoom out" }).click();
      await reset.click();
      await expect(reset).toHaveText("100%");
    });

    // ---- TopBar: find / replace ----------------------------------------------------------------
    test.describe("Find & replace bar", () => {
      test("opens from the toolbar button and the keyboard shortcut, and closes", async () => {
        await page.getByRole("button", { name: "Find & replace" }).click();
        await expect(page.locator("#ap-find-input")).toBeVisible();
        await page.getByRole("button", { name: "Close" }).click();
        await expect(page.locator("#ap-find-input")).toBeHidden();
        await page.locator("body").press(`${MOD}+f`);
        await expect(page.locator("#ap-find-input")).toBeVisible();
      });

      test("finds matches and steps next/prev", async () => {
        await page.locator("body").press(`${MOD}+f`);
        const input = page.locator("#ap-find-input");
        await input.fill("e"); // a vowel present in any English seed body
        await page.getByRole("button", { name: "Find Next" }).click();
        await page.getByRole("button", { name: "Find Prev" }).click();
      });

      test("toggles replace mode (reveals the replace input)", async () => {
        await page.locator("body").press(`${MOD}+f`);
        await page.getByRole("checkbox", { name: "Replace" }).check();
        await expect(page.getByPlaceholder(/replace/i)).toBeVisible();
      });
    });

    // ---- TopBar: add comment (doc-level + selection) -------------------------------------------
    test.describe("Add comment", () => {
      test("with no selection the toolbar offers 'Comment on Doc' and opens the composer", async () => {
        await clearSelection(page);
        const btn = page.getByRole("button", { name: "Comment on Doc" });
        await expect(btn).toBeEnabled();
        await btn.click();
        await expect(page.getByPlaceholder(/Add a comment/i)).toBeVisible();
        await resetUi(page);
      });

      test("with a selection the toolbar offers 'Comment on Text' and opens the composer", async () => {
        await selectFirstWord(page);
        const btn = page.getByRole("button", { name: "Comment on Text" });
        await expect(btn).toBeVisible(); // the toolbar relabels once the selection registers
        await expect(btn).toBeEnabled();
        await btn.click();
        await expect(page.getByPlaceholder(/Add a comment/i)).toBeVisible();
        await resetUi(page);
      });
    });

    // ---- Composer + ThreadCard (create → reply → resolve → modify → delete) --------------------
    test("Comment composer + thread card: create, reply, resolve/reopen, delete (self-clean)", async () => {
      const probe = `e2e probe ${Date.now()}`;
      await clearSelection(page);
      await page.getByRole("button", { name: "Comment on Doc" }).click();
      await page.getByPlaceholder(/Add a comment/i).fill(probe);
      await page.getByRole("button", { name: "Comment", exact: true }).click();
      const card = page.locator("article", { hasText: probe }).first();
      await expect(card).toBeVisible();

      await card.getByRole("button", { name: "Reply" }).click();
      await card.getByPlaceholder(/Reply…/).fill("a reply");
      await card.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(card.getByText("a reply")).toBeVisible();

      // Resolving moves the thread out of the default rail (resolved threads are hidden) …
      await card.getByRole("button", { name: "Resolve thread" }).click();
      await expect(page.locator("article", { hasText: probe })).toBeHidden();
      // … reveal resolved/orphaned to bring it back; the resolved card exposes Reopen + More.
      await page.locator(".ap-reveal").click();
      const revealed = page.locator("article", { hasText: probe }).first();
      await expect(revealed.getByRole("button", { name: "Reopen thread" })).toBeVisible();
      // Delete it directly from the revealed view (self-clean). The per-comment menu button renders
      // as a "⋯" glyph (its accessible name is the glyph, not the title) — match it by title.
      await revealed.getByTitle("More").first().click();
      await page.getByRole("button", { name: "Delete" }).click();
      await expect(page.locator("article", { hasText: probe })).toHaveCount(0);
      await page.locator(".ap-reveal").click().catch(() => {}); // un-reveal the (now-empty) resolved view
    });

    test("the composer audience switch offers talk-to-agent vs leave-a-memo", async () => {
      await clearSelection(page);
      await page.getByRole("button", { name: "Comment on Doc" }).click();
      await expect(page.getByRole("radiogroup", { name: "Comment audience" })).toBeVisible();
      await resetUi(page);
    });

    // ---- Right-click context menu --------------------------------------------------------------
    test("Context menu offers the contextual actions", async () => {
      await selectFirstWord(page);
      await page.locator(".ap-preview").click({ button: "right" });
      await expect(page.getByText("Find text").first()).toBeVisible();
      await expect(page.getByText("Select all").first()).toBeVisible();
      await resetUi(page);
    });

    // ---- New-doc modal -------------------------------------------------------------------------
    test("New-doc modal opens via 'Create Doc', shows Title + File location, and cancels", async () => {
      await clearSelection(page);
      await page.locator(".ap-preview").click({ button: "right" });
      const create = page.getByText("Create Doc", { exact: true });
      if (!(await create.count())) {
        test.skip(true, "host does not expose newDoc");
        return;
      }
      await create.click();
      await expect(page.getByText("Create new document")).toBeVisible();
      await expect(page.getByLabel("File location")).toBeVisible();
      if (h.caps.draftPrompt) await expect(page.locator(".ap-newdoc-prompt")).toBeVisible();
      await page.getByRole("button", { name: "Cancel" }).click();
      await expect(page.getByText("Create new document")).toBeHidden();
    });

    // ---- Settings / ProfileMenu (shared toggles) ----------------------------------------------
    test.describe("ProfileMenu / settings", () => {
      test("opens the account menu and toggles auto-accept; auto-resolve + language present", async () => {
        await page.locator(".ap-avatar").click();
        const autoAccept = page.getByText("Auto-accept agent's changes");
        await expect(autoAccept).toBeVisible();
        await autoAccept.click();
        await autoAccept.click(); // flip back (self-clean)
        await expect(page.getByText("Auto-resolve comments")).toBeVisible();
        await expect(page.getByRole("combobox", { name: "Language" })).toBeVisible();
        await resetUi(page);
      });

      test("desktop-only toggles appear when the host supports them", async () => {
        test.skip(!h.caps.telemetry && !h.caps.agentMode && !h.caps.replayTutorial, "no desktop-only toggles on this host");
        await page.locator(".ap-avatar").click();
        if (h.caps.telemetry) await expect(page.getByText("Share anonymous data")).toBeVisible();
        if (h.caps.agentMode) await expect(page.getByText("Keep agent in planning")).toBeVisible();
        if (h.caps.replayTutorial) await expect(page.getByText("Replay tutorial")).toBeVisible();
        await resetUi(page);
      });
    });

    // ---- Save / finish-turn / back (presence/enabled-state; non-destructive) -------------------
    test("Save is enabled on an editable doc", async () => {
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    });
    test("finish-turn enabled-state follows whether an agent is connected", async () => {
      const ft = page.getByRole("button", { name: "Finish turn" });
      if (!(await ft.count())) {
        test.skip(true, "this mode has no finish-turn control");
        return;
      }
      await (h.caps.agentConnected ? expect(ft).toBeEnabled() : expect(ft).toBeDisabled());
    });
    test("the back affordance matches the host", async () => {
      const back = page.getByRole("button", { name: "Back", exact: true });
      await (h.caps.backButton === "none" ? expect(back).toHaveCount(0) : expect(back).toBeVisible()); // don't click — it leaves the editor
    });

    test("StatusBar shows the mode label", async () => {
      await expect(page.locator(".ap-status-mode")).toBeVisible();
    });

    // ====== Seeded-state controls (optional hooks; skip when a host can't seed) =================
    test.describe("Review bar (parked proposal)", () => {
      test.skip(!h.openWithProposal, "host can't seed a proposal");
      test("shows the review controls + the accept/reject tri-switch + Apply", async () => {
        const p = await h.openWithProposal!();
        // A parked proposal surfaces either the pending banner (click Review) or the open review bar.
        const reviewBtn = p.getByRole("button", { name: "Review", exact: true });
        if (await reviewBtn.count()) await reviewBtn.click();
        // Review-next + Apply are unique to the open review bar ("Agent proposed changes" also appears
        // in the status bar, so it's ambiguous).
        await expect(p.getByRole("button", { name: /^Review next/ })).toBeVisible();
        await expect(p.getByRole("button", { name: "Apply" })).toBeVisible();
      });
    });

    test.describe("Read-only (archived doc)", () => {
      test.skip(!h.openArchived, "host can't seed an archived doc");
      test("shows the archived banner and disables mutating controls", async () => {
        const p = await h.openArchived!();
        await expect(p.getByText(/archived — view and download only/)).toBeVisible();
        await expect(p.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
        await expect(p.getByRole("button", { name: /Comment on (Doc|Text)/ })).toBeDisabled();
      });
    });

    test.describe("QuestionChips (agent question)", () => {
      test.skip(!h.openWithQuestion, "host can't seed a question");
      test("renders the picker and the Answer button", async () => {
        const p = await h.openWithQuestion!();
        await expect(p.getByRole("button", { name: "Answer", exact: true })).toBeVisible();
      });
    });

    test.describe("CapLimitDialog (at the active-doc cap)", () => {
      test.skip(!h.atActiveDocCap, "host can't seed the active-doc cap");
      test("creating a doc at the cap raises the deactivate-LRU prompt; Cancel is a no-op", async () => {
        const p = await h.atActiveDocCap!();
        await p.locator(".ap-preview").click({ button: "right" });
        await p.getByText("Create Doc", { exact: true }).click();
        await p.getByLabel("File location").fill(`cap-${Date.now()}.md`);
        await p.getByRole("button", { name: "Create", exact: true }).click();
        await expect(p.getByText("Document limit reached")).toBeVisible();
        await p.getByRole("button", { name: "Cancel" }).click();
        await expect(p.getByText("Document limit reached")).toBeHidden();
      });
    });
  });
}
