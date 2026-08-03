// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// End-to-end smoke tests for the formatting toolbar's SourceEditorHandle commands, mounted
// against the REAL CodeMirror editor (happy-dom renders it). markdownEdits.test.ts covers the
// toggle logic exhaustively in isolation; this just proves the imperative methods dispatch
// that logic correctly onto the live editor state.

import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceEditor, type SourceEditorHandle } from "../src/SourceEditor";

function mount(value: string, editable = true) {
  const ref = createRef<SourceEditorHandle>();
  let latest = value;
  const onChange = (v: string) => {
    latest = v;
  };
  const utils = render(<SourceEditor ref={ref} value={value} editable={editable} onChange={onChange} />);
  // .cm-content.textContent concatenates CodeMirror's per-line blocks with no "\n" between
  // them — fine for the single-line assertions below, but would silently drop newlines for a
  // multi-line one. `doc()` (the latest onChange value) preserves them; use it instead if a
  // test ever needs to assert multi-line content.
  const text = () => utils.container.querySelector(".cm-content")!.textContent;
  const doc = () => latest;
  const setEditable = (next: boolean) => utils.rerender(<SourceEditor ref={ref} value={latest} editable={next} onChange={onChange} />);
  return { ref, text, doc, setEditable };
}

afterEach(cleanup);

describe("SourceEditor formatting commands", () => {
  it("toggleBold wraps the selection", () => {
    const { ref, text } = mount("Hello world");
    ref.current!.selectRange(0, 5);
    ref.current!.toggleBold();
    expect(text()).toBe("**Hello** world");
  });

  it("toggleBold unwraps an already-bold selection", () => {
    const { ref, text } = mount("**Hello** world");
    ref.current!.selectRange(0, 9);
    ref.current!.toggleBold();
    expect(text()).toBe("Hello world");
  });

  it("toggleBulletList prefixes the current line", () => {
    const { ref, text } = mount("Item one");
    ref.current!.selectRange(0, 0);
    ref.current!.toggleBulletList();
    expect(text()).toBe("- Item one");
  });

  it("toggleChecklist prefixes the current line", () => {
    const { ref, text } = mount("Task");
    ref.current!.selectRange(0, 0);
    ref.current!.toggleChecklist();
    expect(text()).toBe("- [ ] Task");
  });

  it("toggleChecklist recognizes an already-checked '- [x] ' line and strips it", () => {
    const { ref, text } = mount("- [x] Task");
    ref.current!.selectRange(0, 10);
    ref.current!.toggleChecklist();
    expect(text()).toBe("Task");
  });

  it("toggleChecklist / toggleBulletList / toggleOrderedList / toggleBlockquote all work on an empty line", () => {
    for (const [run, expected] of [
      [(r: SourceEditorHandle) => r.toggleChecklist(), "- [ ] "],
      [(r: SourceEditorHandle) => r.toggleBulletList(), "- "],
      [(r: SourceEditorHandle) => r.toggleOrderedList(), "1. "],
      [(r: SourceEditorHandle) => r.toggleBlockquote(), "> "],
    ] as const) {
      const { ref, text } = mount("");
      ref.current!.selectRange(0, 0);
      run(ref.current!);
      expect(text()).toBe(expected);
    }
  });

  it("insertHorizontalRule inserts a padded rule at the cursor", () => {
    const { ref, text } = mount("Para");
    ref.current!.selectRange(4, 4);
    ref.current!.insertHorizontalRule();
    expect(text()).toBe("Para---");
  });

  it("insertLink wraps the selection as a link", () => {
    const { ref, text } = mount("click here");
    ref.current!.selectRange(0, 10);
    ref.current!.insertLink();
    expect(text()).toBe("[click here](url)");
  });

  it("toggleCodeBlock fences the selection", () => {
    const { ref, text } = mount("x = 1");
    ref.current!.selectRange(0, 5);
    ref.current!.toggleCodeBlock();
    expect(text()).toBe("```x = 1```");
  });

  it("no toolbar command mutates the doc once editable flips to false mid-session — e.g. a menu opened, then the doc went read-only/agent-locked", () => {
    // Starts editable (not already locked): the actual bug was a control that opened BEFORE
    // the doc became read-only still working AFTER, which a mount-time editable=false can't
    // exercise — EditorView.editable blocks typing but never blocked v.dispatch() directly.
    const { ref, text, setEditable } = mount("Hello world", true);
    setEditable(false);
    ref.current!.selectRange(0, 5);
    ref.current!.toggleBold();
    ref.current!.setHeading(2);
    ref.current!.insertLink();
    expect(text()).toBe("Hello world"); // untouched post-transition
  });

  it("insertImage inserts the image markdown (angle-bracket destination) at the cursor", () => {
    const { ref, text } = mount("Para");
    ref.current!.selectRange(4, 4);
    ref.current!.insertImage("plan.assets/x.png");
    expect(text()).toBe("Para![](<plan.assets/x.png>)");
  });
});
