// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "../src/Switch";

afterEach(cleanup);

describe("Switch", () => {
  it("reflects checked and fires onChange with the new value", () => {
    const onChange = vi.fn();
    render(<Switch checked={false} onChange={onChange} label="Auto-resolve" />);
    const sw = screen.getByRole("switch", { name: "Auto-resolve" }) as HTMLInputElement;
    expect(sw.checked).toBe(false);
    fireEvent.click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it("prefers ariaLabel over the visible label for the accessible name", () => {
    render(<Switch checked onChange={() => {}} label="visible" ariaLabel="accept change 1" />);
    expect(screen.getByRole("switch", { name: "accept change 1" })).toBeTruthy();
  });

  it("renders the accept/reject variant with ✓/✗ glyphs and the accept class", () => {
    const { rerender } = render(<Switch checked onChange={() => {}} ariaLabel="accept change 1" intent="accept" />);
    const label = screen.getByRole("switch", { name: "accept change 1" }).closest("label")!;
    expect(label.className).toContain("ap-switch--accept");
    // Both glyphs are present in the track; CSS shows the relevant one per state.
    expect(label.querySelector(".ap-sw-yes")?.textContent).toBe("✓");
    expect(label.querySelector(".ap-sw-no")?.textContent).toBe("✗");
    // A plain settings switch (no intent) has neither the accept class nor the glyphs.
    rerender(<Switch checked={false} onChange={() => {}} label="Auto-resolve" />);
    const plain = screen.getByRole("switch", { name: "Auto-resolve" }).closest("label")!;
    expect(plain.className).not.toContain("ap-switch--accept");
    expect(plain.querySelector(".ap-sw-yes")).toBeNull();
  });

  it("renders disabled (the .disabled branch + a non-string label)", () => {
    render(<Switch checked onChange={() => {}} ariaLabel="x" disabled label={<b>node</b>} className="ap-switch-row" />);
    const sw = screen.getByRole("switch", { name: "x" }) as HTMLInputElement;
    expect(sw.disabled).toBe(true);
    expect(sw.closest("label")!.className).toContain("disabled");
    expect(sw.closest("label")!.className).toContain("ap-switch-row");
  });
});
