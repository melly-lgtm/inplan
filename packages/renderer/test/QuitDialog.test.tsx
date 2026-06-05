// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuitDialog } from "../src/QuitDialog";

afterEach(cleanup);

describe("QuitDialog", () => {
  it("shows Save (with the filename) only when dirty; notify always", () => {
    const { rerender } = render(<QuitDialog fileName="plan.plan.md" dirty onQuit={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Save plan\.plan\.md/)).toBeTruthy();
    expect(screen.getByText(/Tell the agent the plan is ready/)).toBeTruthy();
    rerender(<QuitDialog fileName="plan.plan.md" dirty={false} onQuit={() => {}} onCancel={() => {}} />);
    expect(screen.queryByText(/Save plan\.plan\.md/)).toBeNull();
  });

  it("falls back to 'this document' when no filename", () => {
    render(<QuitDialog fileName={null} dirty onQuit={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Save this document/)).toBeTruthy();
  });

  it("Quit reports both flags (default checked when dirty)", () => {
    const onQuit = vi.fn();
    render(<QuitDialog fileName="p.md" dirty onQuit={onQuit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^quit$/i }));
    expect(onQuit).toHaveBeenCalledWith({ save: true, notifyComplete: true });
  });

  it("respects unchecking Save and notify", () => {
    const onQuit = vi.fn();
    render(<QuitDialog fileName="p.md" dirty onQuit={onQuit} onCancel={() => {}} />);
    const [save, notify] = screen.getAllByRole("checkbox");
    fireEvent.click(save!);
    fireEvent.click(notify!);
    fireEvent.click(screen.getByRole("button", { name: /^quit$/i }));
    expect(onQuit).toHaveBeenCalledWith({ save: false, notifyComplete: false });
  });

  it("never reports save=true when not dirty (no Save box)", () => {
    const onQuit = vi.fn();
    render(<QuitDialog fileName="p.md" dirty={false} onQuit={onQuit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^quit$/i }));
    expect(onQuit).toHaveBeenCalledWith({ save: false, notifyComplete: true });
  });

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(<QuitDialog fileName={null} dirty={false} onQuit={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
