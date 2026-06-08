// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A host-injected mode for exercising the open-core mode seam in tests (open-core itself ships
// only TURN; the cloud injects an instant mode). Mirrors the cloud's instant descriptor.

import type { ModeDescriptor } from "../src/mode";

export const INSTANT_TEST_MODE: ModeDescriptor = {
  id: "instant",
  labelKey: "topbar.instant",
  locksEditor: false,
  wake: "any-action",
  autosaveKind: "canonical",
  autosaveDelayMs: 5000,
  applyKind: "canonical",
  showFinishTurn: false,
};
