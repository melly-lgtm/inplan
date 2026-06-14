// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapLimitDialog } from "../src/CapLimitDialog";

afterEach(cleanup);

const open = (over: Partial<Parameters<typeof CapLimitDialog>[0]> = {}) =>
  render(<CapLimitDialog limit={3} lruTitle="Old Plan" onConfirm={() => {}} onCancel={() => {}} {...over} />);

describe("CapLimitDialog", () => {
  it("shows the limit + the LRU title interpolated into the body", () => {
    open();
    expect(screen.getByText(/Document limit reached/)).toBeTruthy();
    expect(screen.getByText(/3-document limit/)).toBeTruthy();
    expect(screen.getByText(/Old Plan/)).toBeTruthy();
  });

  it("Deactivate & create calls onConfirm; Cancel calls onCancel", () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    open({ onConfirm, onCancel });
    fireEvent.click(screen.getByRole("button", { name: /deactivate & create/i }));
    expect(onConfirm).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("focuses Cancel on mount (the safe default for a destructive deactivation)", () => {
    open();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: /^cancel$/i }));
  });

  it("Escape cancels (so keyboard input can't fall through to the new-doc flow underneath)", () => {
    const onCancel = vi.fn();
    open({ onCancel });
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("backdrop click cancels; clicking the dialog itself does not", () => {
    const onCancel = vi.fn();
    const { container } = open({ onCancel });
    fireEvent.mouseDown(container.querySelector(".ap-modal")!); // inside → stopPropagation
    expect(onCancel).not.toHaveBeenCalled();
    fireEvent.mouseDown(container.querySelector(".ap-modal-backdrop")!);
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
