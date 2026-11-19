// @vitest-environment happy-dom
// SPDX-License-Identifier: AGPL-3.0-or-later

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Onboarding, distracts, type OnboardingSignals } from "../src/Onboarding";

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

  /** The editor the tour runs in, with the coach card mounted INSIDE it exactly as App does —
   *  otherwise rule 1 ("only inside the editor") short-circuits every case and the rules below it
   *  are never reached, which silently voids the coverage of everything in ALLOW. */
  function editor(): { root: HTMLElement; mount: HTMLElement } {
    const root = document.createElement("div");
    root.className = "ap-app";
    const mount = document.createElement("div");
    root.appendChild(mount);
    document.body.appendChild(root);
    return { root, mount };
  }
  const tour = (mount: HTMLElement) => render(<Onboarding signals={NONE} onFinish={() => {}} />, { container: mount });
  const blinked = () => document.querySelector(".ap-coach-card")!.classList.contains("ap-coach-blink");

  it("nudges on an off-step click INSIDE the editor — and lets the click through", () => {
    // The card blinks to redirect attention. It does NOT cancel the click: the tour runs over a
    // throwaway sample, so there is nothing to protect by force, and cancelling is what let it
    // deadlock a user against a surface it could not recognise.
    const { root, mount } = editor();
    const stray = document.createElement("button");
    stray.textContent = "Distraction";
    const onStray = vi.fn();
    stray.addEventListener("click", onStray);
    root.appendChild(stray);
    try {
      tour(mount);
      fireEvent.click(stray);
      expect(blinked()).toBe(true); // nudged
      expect(onStray).toHaveBeenCalled(); // …but never swallowed
    } finally {
      root.remove();
    }
  });

  it("does not nudge at its own card — the tour is not a distraction from itself", () => {
    // Load-bearing, and easy to void by accident: if the card is mounted outside the editor the
    // rule above short-circuits and this allowance is never exercised, so Next and Skip would
    // blink the card at the user on every press and no test would notice.
    const { root, mount } = editor();
    try {
      tour(mount);
      fireEvent.click(screen.getByRole("button", { name: /^next$/i }));
      expect(blinked()).toBe(false);
      fireEvent.click(screen.getByRole("button", { name: /skip tutorial/i }));
      expect(blinked()).toBe(false);
    } finally {
      root.remove();
    }
  });

  it("cancels nothing, whatever the click is", () => {
    // The structural property, stated on its own: there is no path through this component that
    // calls preventDefault or stopPropagation, so it cannot trap a user against anything —
    // including a surface nobody thought to exempt.
    const { root, mount } = editor();
    const stray = document.createElement("button");
    root.appendChild(stray);
    try {
      tour(mount);
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      stray.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
      expect(blinked()).toBe(true); // it was a distraction — it just wasn't stopped
    } finally {
      root.remove();
    }
  });

  it("leaves the host app's own chrome alone — it is not the tour's to police", () => {
    // The live report: a consent banner the host put over the editor, whose buttons were the only
    // way to dismiss it. That one happens to carry role="dialog", but the rule deliberately does
    // not lean on it — the commonest cookie bar is a bare div, and the tour has no business
    // judging anything the host app put outside the editor. Hence a roleless one here.
    const bar = document.createElement("div");
    bar.innerHTML = '<button type="button">Accept</button>';
    const onAccept = vi.fn();
    bar.querySelector("button")!.addEventListener("click", onAccept);
    document.body.appendChild(bar);
    const { root, mount } = editor();
    try {
      tour(mount);
      fireEvent.click(bar.querySelector("button")!);
      expect(onAccept).toHaveBeenCalled();
      expect(blinked()).toBe(false); // not even a nudge: nothing happened that concerns the tour
    } finally {
      bar.remove();
      root.remove();
    }
  });

  it("does not nudge at a dialog, in any of the spellings a dialog comes in", () => {
    // A dialog is blocking UI that somebody is waiting on, so redirecting attention away from one
    // is a deadlock, not a nudge. `role="dialog"` is one spelling of it; a native <dialog> and
    // `role="alertdialog"` — the role ARIA prescribes for exactly the interruption-demanding-an-
    // answer case — are just as common, and an attribute selector matches neither.
    const { root, mount } = editor();
    const spellings = [
      { tag: "div", attrs: { role: "dialog" } },
      { tag: "div", attrs: { role: "alertdialog" } },
      { tag: "div", attrs: { "aria-modal": "true" } },
      { tag: "dialog", attrs: { open: "" } },
    ];
    try {
      tour(mount);
      for (const { tag, attrs } of spellings) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
        el.innerHTML = '<button type="button">Decline</button>';
        const onClick = vi.fn();
        el.querySelector("button")!.addEventListener("click", onClick);
        root.appendChild(el);
        fireEvent.click(el.querySelector("button")!);
        expect(onClick, `${tag} ${JSON.stringify(attrs)}`).toHaveBeenCalled();
        expect(blinked(), `${tag} ${JSON.stringify(attrs)}`).toBe(false); // answering a question is not wandering off
        el.remove();
      }
    } finally {
      root.remove();
    }
  });

  it("does not nudge at a banner's action — the reload banner is closing the window on a timer", () => {
    // `.ap-banner-reload` counts down and closes the window at zero. Swallowing its Cancel leaves
    // a first-run user watching an exit they cannot stop, which is worse than the stray click the
    // guard exists to absorb.
    const { root, mount } = editor();
    const banner = document.createElement("div");
    banner.className = "ap-banner ap-banner-reload";
    banner.innerHTML = '<button type="button">Cancel</button>';
    const onCancel = vi.fn();
    banner.querySelector("button")!.addEventListener("click", onCancel);
    root.appendChild(banner);
    try {
      tour(mount);
      fireEvent.click(banner.querySelector("button")!);
      expect(onCancel).toHaveBeenCalled();
      expect(blinked()).toBe(false);
    } finally {
      root.remove();
    }
  });

  it("ends the pulse, so a second nudge is visible too", () => {
    // Under `prefers-reduced-motion` the blink class is a STATIC ring with no animation, so
    // leaving it on lights the card once and makes every later nudge invisible — and the nudge is
    // now the only feedback a stray click gets, since nothing is cancelled.
    vi.useFakeTimers();
    const { root, mount } = editor();
    const stray = document.createElement("button");
    root.appendChild(stray);
    try {
      tour(mount);
      fireEvent.click(stray);
      expect(blinked()).toBe(true);
      act(() => void vi.advanceTimersByTime(1000));
      expect(blinked()).toBe(false); // the pulse ended…
      fireEvent.click(stray);
      expect(blinked()).toBe(true); // …so this one can be seen
    } finally {
      root.remove();
      vi.useRealTimers();
    }
  });

  it("re-spotlights a target that a pane change unmounted and brought back", () => {
    // A step's target can live in a pane the user collapses — the source step forces 3 panes, and
    // collapsing to 1 unmounts its target. The element that comes back is a NEW one, so a
    // spotlight keyed only on the selector string is gone for the rest of the step.
    const { root, mount } = editor();
    const spot = () => document.querySelector('[data-onboard="settings"]')?.classList.contains("ap-coach-target");
    const el = document.createElement("div");
    el.setAttribute("data-onboard", "settings");
    root.appendChild(el);
    try {
      const { rerender } = tour(mount);
      fireEvent.click(screen.getByRole("button", { name: /^next$/i })); // → the settings step
      expect(spot()).toBe(true);

      el.remove(); // the pane collapses…
      const back = document.createElement("div");
      back.setAttribute("data-onboard", "settings");
      root.appendChild(back); // …and comes back as a different element
      rerender(<Onboarding signals={{ ...NONE, panes: 3 }} onFinish={() => {}} />);
      expect(spot()).toBe(true);
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

describe("distracts — the decision, without the DOM glue", () => {
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
      expect(distracts(path, null)).toBe(false); // the dialog is in the path: not a distraction
      expect(distracts([host], null)).toBe(true); // the retargeted host alone: indistinguishable from a stray
    } finally {
      document.querySelector(".ap-app")!.remove();
    }
  });

});
