// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../src/ContextMenu";

afterEach(cleanup);

const items = (onSel: () => void) => [
  { label: "Add comment", onSelect: onSel },
  { label: "Copy", onSelect: () => {}, disabled: true },
];

describe("ContextMenu", () => {
  it("renders items and runs onClose then onSelect on click", () => {
    const onClose = vi.fn();
    const onSel = vi.fn();
    render(<ContextMenu pos={{ x: 10, y: 10 }} items={items(onSel)} onClose={onClose} />);
    fireEvent.click(screen.getByRole("menuitem", { name: "Add comment" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(onSel).toHaveBeenCalledOnce();
  });

  it("disables items flagged disabled", () => {
    render(<ContextMenu pos={{ x: 0, y: 0 }} items={items(() => {})} onClose={() => {}} />);
    expect((screen.getByRole("menuitem", { name: "Copy" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(<ContextMenu pos={{ x: 0, y: 0 }} items={items(() => {})} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on an outside mousedown but not one inside the menu", () => {
    const onClose = vi.fn();
    render(<ContextMenu pos={{ x: 0, y: 0 }} items={items(() => {})} onClose={onClose} />);
    fireEvent.mouseDown(screen.getByRole("menu"));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledOnce();
  });
});
