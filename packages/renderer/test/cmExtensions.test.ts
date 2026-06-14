// SPDX-License-Identifier: AGPL-3.0-or-later

import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { highestPrecKeymap } from "../src/cmExtensions";

describe("highestPrecKeymap", () => {
  it("wraps plain key-bindings into a CodeMirror extension a host can mount", () => {
    let ran = false;
    const ext = highestPrecKeymap([{ key: "Mod-z", run: () => ((ran = true), true) }]);
    // It's a valid extension: an EditorState accepts it without the "unrecognized extension" throw.
    const state = EditorState.create({ doc: "hi", extensions: [ext] });
    expect(state.doc.toString()).toBe("hi");
    expect(ran).toBe(false); // building the extension doesn't run the binding
  });
});
