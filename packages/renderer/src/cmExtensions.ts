// SPDX-License-Identifier: AGPL-3.0-or-later
//
// CodeMirror extension helpers exposed to hosts. A host's live-collab binding can't build CodeMirror
// extensions itself — its `@codemirror/state` would be a *second* instance, and feeding such an
// extension into the editor throws "Unrecognized extension value … multiple instances of
// @codemirror/state". So the host passes plain data and the renderer (the canonical CodeMirror
// instance) builds the extension here.

import { Prec, type Extension } from "@codemirror/state";
import { keymap, type KeyBinding } from "@codemirror/view";

/** Wrap key-bindings at highest precedence, so a host binding's keymap (e.g. the Yjs collaborative
 *  undo/redo bindings) out-precedes the editor's built-in basicSetup keymaps (native `history`). */
export function highestPrecKeymap(bindings: readonly KeyBinding[]): Extension {
  return Prec.highest(keymap.of(bindings));
}
