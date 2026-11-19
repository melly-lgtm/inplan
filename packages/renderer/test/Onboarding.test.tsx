// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding, type OnboardingSignals } from "../src/Onboarding";

afterEach(cleanup);

const NONE: OnboardingSignals = { inline: 0, doc: 0, answered: 0, panes: 1, sourceEdits: 0 };
const nextBtn = () => screen.getByRole("button", { name: /^next$/i }) as HTMLButtonElement;
const next = () => fireEvent.click(nextBtn());

describe("Onboarding", () => {
  it("walks welcome → settings (no gate), then gates the inline step until a comment is added", () => {
    const { rerender } = render(<Onboarding signals={NONE} onFinish={() => {}} />);

    expect(screen.getByText(/welcome to inplan/i)).toBeTruthy();
    next(); // → settings (no gate)
    expect(screen.getByText(/how the agent applies edits/i)).toBeTruthy();
    next(); // → inline (gated)
    expect(screen.getByText(/comment on a line/i)).toBeTruthy();

    // Next is disabled until the user actually adds an inline comment.
    expect(nextBtn().disabled).toBe(true);
    rerender(<Onboarding signals={{ ...NONE, inline: 1 }} onFinish={() => {}} />);
    expect(screen.getByText(/done/i)).toBeTruthy(); // ✓ confirmation
    expect(nextBtn().disabled).toBe(false);
  });

  it("swallows an off-step click and blinks the coach card (but allows the card itself)", () => {
    // A stray control the tour doesn't point at — clicks on it should be ignored.
    const stray = document.createElement("button");
    stray.textContent = "Distraction";
    const onStray = vi.fn();
    stray.addEventListener("click", onStray);
    document.body.appendChild(stray);
    try {
      render(<Onboarding signals={NONE} onFinish={() => {}} />);
      fireEvent.click(stray);
      expect(onStray).not.toHaveBeenCalled(); // the guard swallowed it
      expect(document.querySelector(".ap-coach-card")!.classList.contains("ap-coach-blink")).toBe(true); // blinked
      // The coach card's own controls still work (allowed region).
      const skip = screen.getByRole("button", { name: /skip tutorial/i });
      const onSkipClick = vi.fn();
      skip.addEventListener("click", onSkipClick);
      fireEvent.click(skip);
      expect(onSkipClick).toHaveBeenCalled(); // not swallowed
    } finally {
      stray.remove();
    }
  });

  it("never swallows a dialog's buttons — a tour must not be able to trap the user", () => {
    // The live report: a first visit to a shared document raised BOTH the tour and the host app's
    // consent banner. Accept and Decline did nothing but blink the coach card, because the guard
    // swallowed them — and the banner can only be dismissed by answering it. A dialog is blocking
    // UI that somebody is waiting on; redirecting attention away from one is a deadlock, not a
    // nudge. The tour knows nothing about this element beyond its role, which is the point.
    const banner = document.createElement("div");
    banner.setAttribute("role", "dialog");
    banner.innerHTML = '<button type="button">Accept</button><button type="button">Decline</button>';
    const onAccept = vi.fn();
    const onDecline = vi.fn();
    banner.querySelectorAll("button")[0]!.addEventListener("click", onAccept);
    banner.querySelectorAll("button")[1]!.addEventListener("click", onDecline);
    document.body.appendChild(banner);
    try {
      render(<Onboarding signals={NONE} onFinish={() => {}} />);

      fireEvent.click(banner.querySelectorAll("button")[1]!);
      expect(onDecline).toHaveBeenCalled();
      fireEvent.click(banner.querySelectorAll("button")[0]!);
      expect(onAccept).toHaveBeenCalled();
      // …and the card does not pulse, because answering a dialog is not a distraction.
      expect(document.querySelector(".ap-coach-card")!.classList.contains("ap-coach-blink")).toBe(false);
    } finally {
      banner.remove();
    }
  });

  it("Skip finishes from any step", () => {
    const onFinish = vi.fn();
    render(<Onboarding signals={NONE} onFinish={onFinish} />);
    next(); // move off welcome to prove skip works mid-tour
    fireEvent.click(screen.getByRole("button", { name: /skip tutorial/i }));
    expect(onFinish).toHaveBeenCalledOnce();
  });

  it("reaches the finish step by satisfying each gate, then Open my plan finishes", () => {
    const onFinish = vi.fn();
    let sig: OnboardingSignals = { inline: 0, doc: 0, answered: 0, panes: 1, sourceEdits: 0 };
    const { rerender } = render(<Onboarding signals={sig} onFinish={onFinish} />);
    // Reassign a FRESH object each bump — the step's baseline holds the object captured
    // on entry, so mutating in place would move the baseline with it.
    const bump = (k: keyof OnboardingSignals) => {
      sig = { ...sig, [k]: sig[k] + 1 };
      rerender(<Onboarding signals={sig} onFinish={onFinish} />);
    };

    next(); // → settings (no gate)
    next(); // → inline (gated)
    bump("inline");
    next(); // → doc (gated)
    bump("doc");
    next(); // → answer (gated)
    bump("answered");
    next(); // → layout (gated on a pane change)
    expect(screen.getByText(/arrange the panes/i)).toBeTruthy();
    expect(nextBtn().disabled).toBe(true);
    bump("panes"); // 1 → 2 satisfies the "panes changed" gate
    expect(nextBtn().disabled).toBe(false);
    next(); // → source (gated on a source edit)
    expect(screen.getByText(/edit the markdown source/i)).toBeTruthy();
    expect(nextBtn().disabled).toBe(true);
    bump("sourceEdits");
    expect(nextBtn().disabled).toBe(false);
    next(); // → movedoc (no gate)
    expect(screen.getByText(/split off a new document/i)).toBeTruthy();
    next(); // → finishturn (no gate)
    expect(screen.getByText(/hand the turn back/i)).toBeTruthy();
    next(); // → finish (no gate)
    fireEvent.click(screen.getByRole("button", { name: /open my plan/i }));
    expect(onFinish).toHaveBeenCalledOnce();
  });
});
