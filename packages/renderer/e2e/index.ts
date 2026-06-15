// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public entry for the shared editor-control e2e suite. A host (the Electron desktop spec, or the
// cloud web spec) imports `registerEditorControlSpecs` + the `EditorHarness` type and wires its own
// adapter. Exposed via the package's "./e2e" subpath; raw .ts (Playwright transpiles on import).

export { type EditorHarness, type EditorCaps } from "./harness";
export { registerEditorControlSpecs, type PlaywrightApi } from "./editorControls.shared";
