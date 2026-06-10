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

  it("shows the agent-directed instruction (with the command) copyable only when policy is 'local'", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const cmd = "inplan wait --remote doc-123";
    const { rerender } = render(<AgentIndicator location={null} policy="auto" onSetPolicy={vi.fn()} localCommand={cmd} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(document.body.textContent).not.toContain(cmd); // hidden under "auto"
    rerender(<AgentIndicator location={null} policy="local" onSetPolicy={vi.fn()} localCommand={cmd} />);
    expect(document.body.textContent).toMatch(/coding agent/i); // framed as an agent hand-off, not a human command
    expect(document.body.textContent).toContain("…"); // long instruction shown middle-elided in the box
    fireEvent.click(screen.getByRole("button", { name: /^copy$/i }));
    // Copies the FULL bootstrap instruction (install check + install + login + the connect command).
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain(cmd); // the connect command, in full
    expect(copied).toContain("npm i -g inplan"); // how to install if missing
    expect(copied).toContain("inplan login"); // how to sign in
  });

  it("omits the local-agent command when the host supplies none (desktop)", () => {
    render(<AgentIndicator location="local" policy="local" onSetPolicy={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
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
