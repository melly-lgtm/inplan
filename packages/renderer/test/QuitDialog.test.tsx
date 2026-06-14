// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuitDialog } from "../src/QuitDialog";

afterEach(cleanup);

describe("QuitDialog", () => {
  it("shows only the build-mode toggle (no Save checkbox — quit always saves)", () => {
    render(<QuitDialog onQuit={() => {}} onCancel={() => {}} />);
    expect(screen.getByText(/Switch agent to build mode/)).toBeTruthy();
    expect(screen.queryByText(/^Save\b/)).toBeNull(); // the manual Save prompt is gone
    expect(screen.getAllByRole("checkbox")).toHaveLength(1); // build mode only
  });

  it("Quit defaults: build mode off", () => {
    const onQuit = vi.fn();
    render(<QuitDialog onQuit={onQuit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^quit$/i }));
    expect(onQuit).toHaveBeenCalledWith({ startBuild: false });
  });

  it("opting into build mode reports startBuild=true", () => {
    const onQuit = vi.fn();
    render(<QuitDialog onQuit={onQuit} onCancel={() => {}} />);
    fireEvent.click(screen.getByRole("checkbox")); // the sole (build) toggle → true
    fireEvent.click(screen.getByRole("button", { name: /^quit$/i }));
    expect(onQuit).toHaveBeenCalledWith({ startBuild: true });
  });

  it("Cancel calls onCancel", () => {
    const onCancel = vi.fn();
    render(<QuitDialog onQuit={() => {}} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole("button", { name: /^cancel$/i }));
    expect(onCancel).toHaveBeenCalledOnce();
  });
});
