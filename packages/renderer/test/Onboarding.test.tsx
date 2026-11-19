// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding, swallows, type OnboardingSignals } from "../src/Onboarding";

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

  /** The editor the tour runs in. The guard polices clicks inside this and nowhere else. */
  function editor(): HTMLElement {
    const root = document.createElement("div");
    root.className = "ap-app";
    document.body.appendChild(root);
    return root;
  }
  const blinked = () => document.querySelector(".ap-coach-card")!.classList.contains("ap-coach-blink");

  it("swallows an off-step click INSIDE the editor and blinks the coach card (but allows the card itself)", () => {
    // A stray control the tour doesn't point at — clicks on it should be ignored.
    const root = editor();
    const stray = document.createElement("button");
    stray.textContent = "Distraction";
    const onStray = vi.fn();
    stray.addEventListener("click", onStray);
    root.appendChild(stray);
    try {
      render(<Onboarding signals={NONE} onFinish={() => {}} />);
      fireEvent.click(stray);
      expect(onStray).not.toHaveBeenCalled(); // the guard swallowed it
      expect(blinked()).toBe(true);
      // The coach card's own controls still work (allowed region).
      const skip = screen.getByRole("button", { name: /skip tutorial/i });
      const onSkipClick = vi.fn();
      skip.addEventListener("click", onSkipClick);
      fireEvent.click(skip);
      expect(onSkipClick).toHaveBeenCalled(); // not swallowed
    } finally {
      root.remove();
    }
  });

  it("leaves the host app's own chrome alone — it is not the tour's to police", () => {
    // The live report: a consent banner the host put over the editor. It carried no class or role
    // this file could have predicted, and its buttons were the only way to dismiss it. Whatever
    // lives outside the editor belongs to whoever put it there.
    const bar = document.createElement("div"); // a plain cookie bar: no role, no class, no clue
    bar.innerHTML = '<button type="button">Accept</button>';
    const onAccept = vi.fn();
    bar.querySelector("button")!.addEventListener("click", onAccept);
    document.body.appendChild(bar);
    try {
      render(<Onboarding signals={NONE} onFinish={() => {}} />);
      fireEvent.click(bar.querySelector("button")!);
      expect(onAccept).toHaveBeenCalled();
      expect(blinked()).toBe(false); // not even a nudge: nothing happened that concerns the tour
    } finally {
      bar.remove();
    }
  });

  it("never swallows a dialog's buttons, in any of the spellings a dialog comes in", () => {
    // A dialog is blocking UI that somebody is waiting on, so redirecting attention away from one
    // is a deadlock, not a nudge. `role="dialog"` is one spelling of it; a native <dialog> and
    // `role="alertdialog"` — the role ARIA prescribes for exactly the interruption-demanding-an-
    // answer case — are just as common, and an attribute selector matches neither.
    const root = editor();
    const spellings = [
      { tag: "div", attrs: { role: "dialog" } },
      { tag: "div", attrs: { role: "alertdialog" } },
      { tag: "div", attrs: { "aria-modal": "true" } },
      { tag: "dialog", attrs: { open: "" } },
    ];
    try {
      render(<Onboarding signals={NONE} onFinish={() => {}} />);
      for (const { tag, attrs } of spellings) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        el.innerHTML = '<button type="button">Decline</button>';
        const onClick = vi.fn();
        el.querySelector("button")!.addEventListener("click", onClick);
        root.appendChild(el);
        fireEvent.click(el.querySelector("button")!);
        expect(onClick, `${tag} ${JSON.stringify(attrs)}`).toHaveBeenCalled();
        el.remove();
      }
    } finally {
      root.remove();
    }
  });

  it("never swallows a banner's action — the reload banner is closing the window on a timer", () => {
    // `.ap-banner-reload` counts down and closes the window at zero. Swallowing its Cancel leaves
    // a first-run user watching an exit they cannot stop, which is worse than the stray click the
    // guard exists to absorb.
    const root = editor();
    const banner = document.createElement("div");
    banner.className = "ap-banner ap-banner-reload";
    banner.innerHTML = '<button type="button">Cancel</button>';
    const onCancel = vi.fn();
    banner.querySelector("button")!.addEventListener("click", onCancel);
    root.appendChild(banner);
    try {
      render(<Onboarding signals={NONE} onFinish={() => {}} />);
      fireEvent.click(banner.querySelector("button")!);
      expect(onCancel).toHaveBeenCalled();
    } finally {
      root.remove();
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

describe("swallows — the decision, without the DOM glue", () => {
  /** Build `.ap-app > host > dialog > button` and return the click's composed path, innermost first. */
  function shadowish(): { path: Element[]; host: Element } {
    const root = document.createElement("div");
    root.className = "ap-app";
    const host = document.createElement("div");
    const dlg = document.createElement("div");
    dlg.setAttribute("role", "dialog");
    const button = document.createElement("button");
    dlg.appendChild(button);
    host.appendChild(dlg);
    root.appendChild(host);
    document.body.appendChild(root);
    return { path: [button, dlg, host, root, document.body], host };
  }

  it("sees a dialog anywhere in the PATH, not just at the target", () => {
    // A document listener gets `e.target` RETARGETED to the shadow host, so judging the target
    // alone tests the wrong element — which is how a consent banner built inside a shadow root
    // (OneTrust, Cookiebot and friends) gets its buttons swallowed anyway.
    const { path, host } = shadowish();
    try {
      expect(swallows(path, null)).toBe(false); // the dialog is in the path: allowed
      expect(swallows([host], null)).toBe(true); // the retargeted host alone: indistinguishable from a stray
    } finally {
      document.querySelector(".ap-app")!.remove();
    }
  });

  it("never swallows blind", () => {
    expect(swallows([], null)).toBe(false); // nothing identifiable to judge
  });
});
