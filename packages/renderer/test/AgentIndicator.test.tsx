// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentIndicator } from "../src/AgentIndicator";

afterEach(cleanup);

describe("AgentIndicator", () => {
  it("labels remote/local/disconnected with the model", () => {
    const { rerender } = render(<AgentIndicator location="cloud" model="Opus 4.8" />);
    expect(screen.getByRole("button").textContent).toContain("remote (Opus 4.8)");
    rerender(<AgentIndicator location="local" model="Sonnet 4.6" />);
    expect(screen.getByRole("button").textContent).toContain("local (Sonnet 4.6)");
    rerender(<AgentIndicator location={null} />);
    expect(screen.getByRole("button").textContent).toContain("disconnected");
  });

  it("shows a quota pie with a percentage for a metered cloud agent", () => {
    render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 0.42, overage: false }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.body.textContent).toContain("Plan 42%");
  });

  it("opens the connection-policy picker and reports a change", () => {
    const onSetPolicy = vi.fn();
    render(<AgentIndicator location="cloud" model="Opus" policy="auto" onSetPolicy={onSetPolicy} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(screen.getByRole("menuitemradio", { name: /Connect a cloud agent/ }).getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByRole("menuitemradio", { name: /Wait for my local agent/ }));
    expect(onSetPolicy).toHaveBeenCalledWith("local");
  });

  it("omits the picker when no policy handler is given", () => {
    render(<AgentIndicator location="local" model="x" />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
