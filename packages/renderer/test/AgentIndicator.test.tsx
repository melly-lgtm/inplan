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

  it("tints the pie for overage and shows the over-included note", () => {
    render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 1.1, overage: true }} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title")).toContain("(over)");
    const pie = btn.querySelector(".ap-agent-pie") as HTMLElement;
    expect(pie.style.background).toContain("#e67e22"); // orange on overage
    fireEvent.click(btn);
    expect(document.body.textContent).toContain("over included");
  });

  it("uses the BYO-key tint when the user brings their own key", () => {
    render(<AgentIndicator location="cloud" model="Opus" byoKey quota={{ usedPct: 0.2, overage: false }} />);
    const pie = screen.getByRole("button").querySelector(".ap-agent-pie") as HTMLElement;
    expect(pie.style.background).toContain("var(--agent-byo");
  });

  it("closes the menu on an outside mousedown", () => {
    render(<AgentIndicator location="cloud" model="Opus" policy="auto" onSetPolicy={vi.fn()} />);
    const btn = screen.getByRole("button");
    fireEvent.click(btn);
    expect(screen.getByRole("radiogroup")).toBeTruthy();
    fireEvent.mouseDown(document.body); // click outside
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });
});
