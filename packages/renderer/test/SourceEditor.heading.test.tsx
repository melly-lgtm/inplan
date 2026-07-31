// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// setHeading(level): sets/clears the ATX heading prefix on the cursor's line, used by the
// source pane's blog-editor-style H1/H2/H3 toolbar (App.tsx's SourceToolbar).

import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { SourceEditor, type SourceEditorHandle } from "../src/SourceEditor";

function mount(value: string) {
  const ref = createRef<SourceEditorHandle>();
  const utils = render(<SourceEditor ref={ref} value={value} editable onChange={() => {}} />);
  return { ref, ...utils };
}

afterEach(cleanup);

describe("SourceEditor.setHeading", () => {
  it("adds a heading prefix to a plain line", () => {
    const { ref, container } = mount("Hello world");
    ref.current!.selectRange(2, 2); // cursor inside the line
    ref.current!.setHeading(2);
    expect(container.querySelector(".cm-content")!.textContent).toBe("## Hello world");
  });

  it("clicking the same level again clears it back to a paragraph", () => {
    const { ref, container } = mount("Hello world");
    ref.current!.setHeading(1);
    expect(container.querySelector(".cm-content")!.textContent).toBe("# Hello world");
    ref.current!.setHeading(1); // toggle off
    expect(container.querySelector(".cm-content")!.textContent).toBe("Hello world");
  });

  it("switching levels replaces the existing prefix rather than stacking it", () => {
    const { ref, container } = mount("Hello world");
    ref.current!.setHeading(1);
    ref.current!.setHeading(3);
    expect(container.querySelector(".cm-content")!.textContent).toBe("### Hello world");
  });

  it("only affects the current line, not the whole document", () => {
    const { ref, container } = mount("First\nSecond\nThird");
    ref.current!.selectRange(6, 6); // inside "Second"
    ref.current!.setHeading(2);
    expect(container.querySelector(".cm-content")!.textContent).toBe("First## SecondThird");
  });
});
