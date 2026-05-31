// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerPopover } from "../src/renderer/ComposerPopover";

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
    expect(onSubmit).toHaveBeenCalledWith("a remark");
  });

  it("Comment button is disabled until there's text, then submits", () => {
    const onSubmit = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} />);
    expect(commentBtn().disabled).toBe(true);
    fireEvent.change(textarea(), { target: { value: "hi" } });
    expect(commentBtn().disabled).toBe(false);
    fireEvent.click(commentBtn());
    expect(onSubmit).toHaveBeenCalledWith("hi");
  });

  it("cancel closes without submitting", () => {
    const onSubmit = vi.fn();
    const onClose = vi.fn();
    render(<ComposerPopover {...base} onSubmit={onSubmit} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
