// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NewDocModal } from "../src/NewDocModal";

afterEach(cleanup);

const base = { mode: "create" as const, initialTitle: "My Section", initialPath: "my_section.md", exists: false, onPick: null, onSubmit: vi.fn(), onCancel: vi.fn() };
const titleInput = () => screen.getByDisplayValue("My Section") as HTMLInputElement;
const pathInput = () => screen.getByDisplayValue("my_section.md") as HTMLInputElement;

describe("NewDocModal", () => {
  it("shows the create vs move heading + action label", () => {
    const { rerender } = render(<NewDocModal {...base} />);
    expect(document.body.textContent).toContain("Create new document");
    expect(screen.getByRole("button", { name: /^create$/i })).toBeTruthy();
    rerender(<NewDocModal {...base} mode="move" />);
    expect(document.body.textContent).toContain("Move blocks to a new document");
    expect(screen.getByRole("button", { name: /^move$/i })).toBeTruthy();
  });

  it("submits the trimmed title + path on the action button and on Enter", () => {
    const onSubmit = vi.fn();
    render(<NewDocModal {...base} onSubmit={onSubmit} />);
    fireEvent.change(titleInput(), { target: { value: "  Renamed  " } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));
    expect(onSubmit).toHaveBeenCalledWith("Renamed", "my_section.md", { append: true });
    fireEvent.keyDown(pathInput(), { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledTimes(2);
  });

  it("when the target exists: warns, and the action becomes Link (create) or Append (move, default)", () => {
    const onSubmit = vi.fn();
    // Create mode: no append option, action links to the existing doc.
    const { rerender } = render(<NewDocModal {...base} exists onSubmit={onSubmit} />);
    expect(document.body.textContent).toContain("That file already exists.");
    expect(screen.queryByRole("checkbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /link to it/i }));
    expect(onSubmit).toHaveBeenCalledWith("My Section", "my_section.md", { append: true });

    // Move mode: an Append checkbox (default on) → action is Append; unchecking → Link, append:false.
    onSubmit.mockClear();
    rerender(<NewDocModal {...base} mode="move" exists onSubmit={onSubmit} />);
    const appendBox = screen.getByRole("checkbox") as HTMLInputElement;
    expect(appendBox.checked).toBe(true);
    expect(screen.getByRole("button", { name: /^append$/i })).toBeTruthy();
    fireEvent.click(appendBox); // uncheck → link instead
    fireEvent.click(screen.getByRole("button", { name: /link to it/i }));
    expect(onSubmit).toHaveBeenCalledWith("My Section", "my_section.md", { append: false });
  });

  it("disables the action when the title or path is empty", () => {
    render(<NewDocModal {...base} />);
    const create = screen.getByRole("button", { name: /^create$/i }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    // Hold the inputs by reference — the helpers query by display value, which changes below.
    const title = titleInput();
    const path = pathInput();
    fireEvent.change(title, { target: { value: "   " } });
    expect(create.disabled).toBe(true);
    // A whitespace-only path also disables the action (the second guard).
    fireEvent.change(title, { target: { value: "Valid Title" } });
    fireEvent.change(path, { target: { value: "   " } });
    expect(create.disabled).toBe(true);
  });

  it("shows Browse only with onPick, and adopts the picked path", async () => {
    const { rerender } = render(<NewDocModal {...base} />);
    expect(screen.queryByRole("button", { name: /browse/i })).toBeNull(); // no picker → no Browse
    const onPick = vi.fn(async () => "picked/elsewhere.md");
    rerender(<NewDocModal {...base} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    await screen.findByDisplayValue("picked/elsewhere.md");
    expect(onPick).toHaveBeenCalledWith("my_section.md");
  });

  it("keeps the path when the picker is cancelled (returns null)", async () => {
    const onPick = vi.fn(async () => null);
    render(<NewDocModal {...base} onPick={onPick} />);
    fireEvent.click(screen.getByRole("button", { name: /browse/i }));
    expect(await screen.findByDisplayValue("my_section.md")).toBeTruthy(); // unchanged
  });

  it("cancels via the button and via Escape", () => {
    const onCancel = vi.fn();
    const { unmount } = render(<NewDocModal {...base} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(2);
    unmount();
  });

  it("dismisses on a backdrop click but not on a click inside the dialog", () => {
    const onCancel = vi.fn();
    render(<NewDocModal {...base} onCancel={onCancel} />);
    fireEvent.mouseDown(document.querySelector(".ap-newdoc")!); // inside → kept
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.querySelector(".ap-modal-backdrop")!); // backdrop → dismiss
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
