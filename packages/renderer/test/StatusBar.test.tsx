// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StatusBar } from "../src/StatusBar";

afterEach(cleanup);

const base = { cadence: "turn" as const, status: "", dirty: false, agentThinking: false, messages: [], canTakeBack: false, onTakeBack: () => {} };

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
    expect(document.body.textContent).toContain("Instant mode");
    expect(document.body.textContent).toContain("unsaved");
  });

  it("surfaces the latest agent message and opens a history popup on click", () => {
    const messages = [
      { text: "first note", ts: "2026-01-01T08:00:00Z" },
      { text: "latest note", ts: "2026-01-01T09:30:00Z" },
    ];
    render(<StatusBar {...base} messages={messages} />);
    // The latest message shows as a clickable chip.
    const chip = screen.getByRole("button", { name: /latest note/i });
    expect(document.body.textContent).not.toContain("first note"); // history hidden until opened
    fireEvent.click(chip);
    // Popup lists the full history, including the earlier note.
    expect(document.body.textContent).toContain("first note");
    // Time is now relative (dayjs fromNow); the exact ISO is preserved on the <time> element.
    expect(document.querySelector('time[datetime="2026-01-01T09:30:00Z"]')).toBeTruthy();
  });

  it("shows no message chip when there are no agent messages", () => {
    render(<StatusBar {...base} status="ready" />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("auto mode: opens the window on the agent's turn and closes it on the user's turn", () => {
    const messages = [{ text: "working…", ts: "2026-01-01T09:00:00Z" }];
    const { rerender } = render(<StatusBar {...base} messages={messages} agentThinking />);
    expect(document.querySelector(".ap-agentmsg-pop")).toBeTruthy(); // agent's turn → auto-open
    rerender(<StatusBar {...base} messages={messages} agentThinking={false} />);
    expect(document.querySelector(".ap-agentmsg-pop")).toBeNull(); // user's turn → auto-close
  });

  it("lists messages chronologically (newest at the bottom) with toned-down markup", () => {
    const messages = [
      { text: "older", ts: "2026-01-01T08:00:00Z" },
      { text: "**done**", ts: "2026-01-01T09:00:00Z" },
    ];
    render(<StatusBar {...base} messages={messages} agentThinking />);
    const items = Array.from(document.querySelectorAll(".ap-agentmsg-item"));
    expect(items[0]!.textContent).toContain("older");
    expect(items[items.length - 1]!.textContent).toContain("done"); // newest last
    expect(document.querySelector(".ap-md-strong")?.textContent).toBe("done"); // not literal **
  });
});
