// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The host-agnostic seam for the SHARED editor-control e2e suite. Both hosts that render
// @inplan/renderer — the Electron desktop app (open-core) and the inplan.ai web app (cloud) —
// implement this interface, and `registerEditorControlSpecs(harness)` (editorControls.shared.ts)
// drives the identical editor UI through it. This file MUST stay free of any host specifics
// (no Electron, no Supabase/web) — every host difference is expressed via `caps` flags or the
// OPTIONAL seeded-state hooks (a host that can't seed a given state simply omits the hook and the
// matching specs `test.skip()`).

import type { Page } from "@playwright/test";

/** Host-specific capabilities so the shared specs guard a control instead of branching on host. */
export interface EditorCaps {
  /** The TopBar Back/leave affordance: desktop quits the window; web returns to the plan list. */
  backButton: "quit" | "plans" | "none";
  /** The presence-aware agent indicator + policy controls (cloud only). */
  agentIndicator: boolean;
  /** The NewDocModal "draft from a prompt" field (cloud paid orgs only). */
  draftPrompt: boolean;
  /** ProfileMenu desktop-only toggles. */
  telemetry: boolean;
  agentMode: boolean;
  replayTutorial: boolean;
  /** A connected agent is present, so finish-turn / cadence controls are enabled (vs the no-agent
   *  desktop default where they're disabled). */
  agentConnected: boolean;
}

/**
 * A host adapter the shared suite drives. `openEditor` returns a Page already on an editable
 * document with the onboarding tour dismissed; the host owns the Page's lifecycle (the web host
 * typically keeps one signed-in page and reuses it, the Electron host reuses its single window).
 * The shared specs are written to be non-destructive or self-cleaning, so a reused Page is safe.
 */
export interface EditorHarness {
  host: "web" | "electron";
  caps: EditorCaps;
  /** Open the editor on an editable doc and return its Page (onboarding already skipped). */
  openEditor(seed?: { body?: string }): Promise<Page>;

  // --- OPTIONAL seeded-state hooks (specs skip when a host omits one) -------------------------
  /** A doc with a parked agent proposal → the review bar (next/tri-switch/apply) + pending banner. */
  openWithProposal?(): Promise<Page>;
  /** An archived (active=false) doc → the read-only banner + disabled mutating controls. */
  openArchived?(): Promise<Page>;
  /** A doc carrying an unanswered agent question → the QuestionChips picker. */
  openWithQuestion?(): Promise<Page>;
  /** The org at its active-doc cap → creating a doc raises the CapLimitDialog. */
  atActiveDocCap?(): Promise<Page>;
}
