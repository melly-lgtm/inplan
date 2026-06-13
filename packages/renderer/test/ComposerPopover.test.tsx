// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPopover } from "../src/ComposerPopover";
import { MOD_KEY } from "../src/platform";

afterEach(cleanup);

const base = { target: null as string | null, pos: { x: 10, y: 10 }, disabled: false, onSubmit: () => {}, onClose: () => {} };
const textarea = () => screen.getByPlaceholderText(/Add a comment/) as HTMLTextAreaElement;
const commentBtn = () => screen.getByRole("button", { name: /^comment$/i }) as HTMLButtonElement;

describe("ComposerPopover", () => {
  it("shows the anchored target, or a document-level label", () => {
    const { rerender } = render(<ComposerPopover {...base} target="use Postgres" />);
    expect(document.body.textContent).toContain("use Postgres");
    rerender(<ComposerPopover {...base} target={null} />);
    expect(document.body.textContent).toContain("document-level comment");
  });

  it("submits trimmed text on ⌘/Ctrl+Enter", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    fireEvent.change(textarea(), { target: { value: "  a remark  " } });
    fireEvent.keyDown(textarea(), { key: "Enter", metaKey: true });
    expect(onSubmit).toHaveBeenCalledWith("a remark", true); // default audience = talk to the agent
  });

  it("Comment button is disabled until there's text, then submits", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    expect(commentBtn().disabled).toBe(true);
    fireEvent.change(textarea(), { target: { value: "hi" } });
    expect(commentBtn().disabled).toBe(false);
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("hi", true);
  });

  it("the audience switch defaults to 'talk to the agent'; choosing 'leave a memo' submits agent=false", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    const memo = screen.getByRole("radio", { name: /leave a memo/i });
    const talk = screen.getByRole("radio", { name: /talk to the agent/i });
    expect(talk.getAttribute("aria-checked")).toBe("true"); // conversation is the default
    expect(memo.getAttribute("aria-checked")).toBe("false");
    fireEvent.change(textarea(), { target: { value: "note to self" } });
    fireEvent.click(memo); // switch to memo
    expect(memo.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("note to self", false); // memo → the agent ignores it
  });

  it("shows the OS-specific modifier in the placeholder, not the dual 'Cmd/Ctrl'", () => {
    render(<ComposerPopover {...base} />);
    const ph = textarea().placeholder;
    expect(ph).toContain(`${MOD_KEY}+Enter`);
    expect(ph).not.toContain("/Ctrl"); // no longer the dual "⌘/Ctrl" form
  });

  it("cancel closes without submitting", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("drags via the header, and only dismisses on an outside click when empty", () => {
    const onClose = vi.fn();
    render(<ComposerPopover {...base} onClose={onClose} />);
    const head = document.querySelector(".ap-composer-head") as HTMLElement;
    fireEvent.mouseDown(head, { clientX: 50, clientY: 50 }); // start drag
    fireEvent.mouseMove(document, { clientX: 80, clientY: 90 }); // moves the popover (setP)
    fireEvent.mouseUp(document); // end drag
    // Outside click with text present must NOT dismiss (don't discard a draft).
    fireEvent.change(textarea(), { target: { value: "draft" } });
    fireEvent.mouseDown(document.body);
    expect(onClose).not.toHaveBeenCalled();
    // Emptied → an outside click dismisses.
    fireEvent.change(textarea(), { target: { value: "" } });
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
