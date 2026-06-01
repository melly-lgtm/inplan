// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../src/StatusBar";

afterEach(cleanup);

const base = { cadence: "turn" as const, status: "", dirty: false, agentThinking: false, canTakeBack: false, onTakeBack: () => {} };

describe("StatusBar", () => {
  it("shows the status text and no take-back button when the agent isn't thinking", () => {
    render(<StatusBar {...base} status="ready" />);
    expect(document.body.textContent).toContain("ready");
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("shows 'Agent is thinking' and a working take-back button when locked", () => {
    const onTakeBack = vi.fn();
    render(<StatusBar {...base} agentThinking canTakeBack onTakeBack={onTakeBack} />);
    expect(document.body.textContent).toContain("Agent is thinking");
    fireEvent.click(screen.getByRole("button", { name: /take back control/i }));
    expect(onTakeBack).toHaveBeenCalledTimes(1);
  });

  it("renders the take-back button into the DOM only when canTakeBack (the hover reveal is CSS)", () => {
    const { rerender } = render(<StatusBar {...base} agentThinking canTakeBack={false} />);
    expect(screen.queryByRole("button")).toBeNull();
    rerender(<StatusBar {...base} agentThinking canTakeBack />);
    expect(screen.getByRole("button", { name: /take back control/i })).toBeTruthy();
  });

  it("shows the cadence and an unsaved marker", () => {
    render(<StatusBar {...base} cadence="instant" dirty />);
    expect(document.body.textContent).toContain("instant mode");
    expect(document.body.textContent).toContain("unsaved");
  });
});
