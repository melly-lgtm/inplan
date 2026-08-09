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

  it("draws the quota gauge as a green centre (connected) with the usage on the outer ring", () => {
    render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 0.42, overage: false }} />);
    const pie = screen.getByRole("button").querySelector(".ap-agent-pie") as HTMLElement;
    // Usage lives on the conic ring; a green core child is the connected indicator.
    expect(pie.style.background).toContain("conic-gradient");
    expect(pie.querySelector(".ap-agent-pie-core")).toBeTruthy();
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

  it("tints the pie red for overage and shows the over-included note", () => {
    render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 1.1, overage: true }} />);
    const btn = screen.getByRole("button");
    expect(btn.getAttribute("title")).toContain("(over)");
    const pie = btn.querySelector(".ap-agent-pie") as HTMLElement;
    expect(pie.style.background).toContain("#c0392b"); // red on overage
    fireEvent.click(btn);
    expect(document.body.textContent).toContain("over included");
  });

  it("tints the usage ring by threshold: light green <75%, amber 75–95%, red ≥95%", () => {
    const ring = (usedPct: number): string => {
      const { unmount } = render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct, overage: false }} />);
      const bg = (screen.getByRole("button").querySelector(".ap-agent-pie") as HTMLElement).style.background;
      unmount();
      return bg;
    };
    expect(ring(0.5)).toContain("#3fa46a"); // light green
    expect(ring(0.8)).toContain("#e0a23b"); // amber
    expect(ring(0.97)).toContain("#c0392b"); // red
  });

  it("warns when a capped plan approaches the limit (≥80%, under cap)", () => {
    render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 0.85, overage: false }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector(".ap-agent-quota-near")?.textContent).toContain("Approaching your usage limit");
    expect(document.querySelector(".ap-agent-quota-at")).toBeNull();
  });

  it("reports a paused state when a capped plan is at/over the limit", () => {
    render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 1, overage: false }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.querySelector(".ap-agent-quota-at")?.textContent).toContain("Usage limit reached");
    expect(document.querySelector(".ap-agent-quota-near")).toBeNull();
  });

  it("shows no limit warning under 80% or when overage is allowed", () => {
    const { rerender } = render(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 0.5, overage: false }} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.body.textContent).toContain("Plan 50%"); // menu is open
    expect(document.querySelector(".ap-agent-quota-warn")).toBeNull();
    // Over the cap but on an overage-allowed plan → never warns/pauses. rerender keeps the same
    // instance (open state preserved), so the menu stays open — assert the visible quota to prove
    // it, keeping the no-warn check meaningful (re-clicking would toggle the menu shut).
    rerender(<AgentIndicator location="cloud" model="Opus" quota={{ usedPct: 1.2, overage: true }} />);
    expect(document.body.textContent).toContain("Plan 120%");
    expect(document.querySelector(".ap-agent-quota-warn")).toBeNull();
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
    // Copies the FULL bootstrap instruction (install check + install + the connect command).
    const copied = writeText.mock.calls[0][0] as string;
    expect(copied).toContain(cmd); // the connect command, in full
    expect(copied).toContain("npm i -g inplan@latest"); // installs OR updates — an out-of-date CLI fails silently
    expect(copied).toContain("inplan login"); // explicit sign-in step so headless (non-TTY) agents aren't relying on interactive-only auto-login
  });

  it("omits the local-agent command when the host supplies none (desktop)", () => {
    render(<AgentIndicator location="local" policy="local" onSetPolicy={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(screen.queryByRole("button", { name: /^copy$/i })).toBeNull();
  });

  // A turn-based local agent's CLI exits between turns, so its presence peer vanishes for exactly as
  // long as the agent is busy. Presence alone therefore reads "disconnected" while it works and
  // "connected" only while it idles — inverted. `working` is the third state that fixes that.
  it("reads 'working', not 'disconnected', when the agent holds the turn with no peer", () => {
    render(<AgentIndicator location={null} working />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("working");
    expect(btn.textContent).not.toContain("disconnected");
    expect(btn.querySelector(".ap-agent-working")).toBeTruthy();
    expect(btn.querySelector(".ap-agent-off")).toBeNull(); // never the red "nobody is coming" dot
  });

  it("still reads 'disconnected' when no agent holds the turn", () => {
    render(<AgentIndicator location={null} />);
    expect(screen.getByRole("button").textContent).toContain("disconnected");
    expect(screen.getByRole("button").querySelector(".ap-agent-off")).toBeTruthy();
  });

  it("keeps the location label and adds 'working' when a peer IS present and busy", () => {
    render(<AgentIndicator location="local" model="Opus 5" working />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("local (Opus 5)");
    expect(btn.textContent).toContain("working");
    expect(btn.querySelector(".ap-agent-working")).toBeTruthy();
  });

  it("marks a busy cloud agent as working without losing its quota pie", () => {
    render(<AgentIndicator location="cloud" model="Opus" working quota={{ usedPct: 0.4, overage: false }} />);
    const btn = screen.getByRole("button");
    expect(btn.textContent).toContain("remote (Opus)");
    expect(btn.textContent).toContain("working");
    expect(btn.querySelector(".ap-agent-pie")).toBeTruthy();
  });

  it("the opened menu says working too, instead of contradicting the button with 'No agent connected'", () => {
    render(<AgentIndicator location={null} working />);
    fireEvent.click(screen.getByRole("button"));
    const detail = document.querySelector(".ap-agent-detail")?.textContent ?? "";
    expect(detail).toMatch(/working/i);
    expect(document.body.textContent).not.toMatch(/No agent connected/i);
    // …but it must not INVENT a location. `working` carries none, and "your machine" would only be
    // right because a local CLI happens to be the one agent shaped this way today.
    expect(detail).not.toMatch(/your machine/i);
    expect(detail).not.toMatch(/cloud/i);
  });

  it("the menu keeps saying 'No agent connected' when nothing holds the turn", () => {
    render(<AgentIndicator location={null} />);
    fireEvent.click(screen.getByRole("button"));
    expect(document.body.textContent).toMatch(/No agent connected/i);
  });

  it("a busy agent WITH a peer shows both where it runs and that it is working", () => {
    render(<AgentIndicator location="local" model="Opus 5" working />);
    fireEvent.click(screen.getByRole("button"));
    const detail = document.querySelector(".ap-agent-detail")?.textContent ?? "";
    expect(detail).toMatch(/your machine/i);
    expect(detail).toMatch(/Opus 5/);
    expect(detail).toMatch(/working/i);
  });

  // Showing the connect command to someone whose plan can't use it is what produced a CLI that
  // attaches, consumes turns, and then silently can't edit.
  it("replaces the connect command with an upgrade CTA when the local agent isn't entitled", () => {
    const onUpgrade = vi.fn();
    const cmd = "inplan wait --remote doc-123";
    render(<AgentIndicator location={null} policy="local" onSetPolicy={vi.fn()} localCommand={cmd} localEntitled={false} onUpgrade={onUpgrade} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(document.body.textContent).not.toContain(cmd);
    expect(document.body.textContent).toMatch(/Pro and above/i);
    fireEvent.click(screen.getByRole("button", { name: /see plans/i }));
    expect(onUpgrade).toHaveBeenCalledTimes(1);
  });

  it("shows the reason but no CTA when the host offers no upgrade path", () => {
    render(<AgentIndicator location={null} policy="local" onSetPolicy={vi.fn()} localCommand="c" localEntitled={false} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(document.body.textContent).toMatch(/Pro and above/i);
    expect(screen.queryByRole("button", { name: /see plans/i })).toBeNull();
  });

  it("only an explicit false gates — an ungated host (undefined) still gets the command", () => {
    const cmd = "inplan wait --remote doc-9";
    const { rerender } = render(<AgentIndicator location={null} policy="local" onSetPolicy={vi.fn()} localCommand={cmd} />);
    fireEvent.click(screen.getByRole("button", { name: /agent connection/i }));
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy();
    rerender(<AgentIndicator location={null} policy="local" onSetPolicy={vi.fn()} localCommand={cmd} localEntitled />);
    expect(screen.getByRole("button", { name: /^copy$/i })).toBeTruthy();
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
