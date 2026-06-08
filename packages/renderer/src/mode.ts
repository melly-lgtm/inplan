// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Collaboration modes are a seam. Open-core ships exactly one built-in mode — TURN (the
// single-writer, turn-taking loop). A host (the cloud edition) can inject additional modes via
// `Api.extraModes`; the editor renders a toggle per available mode and reads each mode's policy
// (lock behaviour, autosave, apply, Finish-turn) from its descriptor. The CLI stays mode-agnostic:
// it gates off the `wake`/`locksEditor` policy that `setMode` records into the control log, so it
// never needs to know any specific mode by name.

import type { SaveOptions } from "./api";

export interface ModeDescriptor {
  /** Stable mode id, recorded as the doc's cadence in the control log. */
  id: string;
  /** i18n key for the toggle button label. */
  labelKey: string;
  /** Does the editor lock ("agent is thinking…") while the agent holds the turn? */
  locksEditor: boolean;
  /** When the CLI should wake the agent: at turn-end only, or on any user action. */
  wake: "turn-end" | "any-action";
  /** Autosave persistence: "canonical" wakes the agent; "backup" is silent. */
  autosaveKind: Extract<SaveOptions["kind"], "canonical" | "backup">;
  /** Debounce before an autosave fires. */
  autosaveDelayMs: number;
  /** How accepting a proposal persists: "canonical" (wakes) or "apply" (silent). */
  applyKind: Extract<SaveOptions["kind"], "canonical" | "apply">;
  /** Whether the "Finish turn" hand-off button is shown. */
  showFinishTurn: boolean;
}

/** The doc-control policy a mode imposes on the CLI gate — recorded into the ModeChanged event so
 *  the (mode-agnostic) CLI can honour it without knowing the mode. */
export interface ModePolicy {
  wake: "turn-end" | "any-action";
  locksEditor: boolean;
}

/** The single built-in mode shipped by open-core. */
export const TURN_MODE: ModeDescriptor = {
  id: "turn",
  labelKey: "topbar.turn",
  locksEditor: true,
  wake: "turn-end",
  autosaveKind: "backup",
  autosaveDelayMs: 1500,
  applyKind: "apply",
  showFinishTurn: true,
};

/** Resolve the active mode by id from the available set, falling back to TURN. */
export function resolveMode(id: string, modes: ModeDescriptor[]): ModeDescriptor {
  return modes.find((m) => m.id === id) ?? TURN_MODE;
}
