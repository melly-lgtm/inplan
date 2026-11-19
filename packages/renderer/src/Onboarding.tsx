// SPDX-License-Identifier: AGPL-3.0-or-later
//
// First-run guided tour. A non-blocking "coach card" walks the user through a
// throwaway sample plan (loaded by AppRoot via an in-memory api), spotlighting the
// real controls — the settings menu, the preview, the comments rail — and letting
// them practice for real. The comment/answer steps gate Next until the user actually
// does the thing (counts come in via `signals`); a Skip link always escapes.

import { useEffect, useRef, useState } from "react";
import { MOD_KEY } from "./platform";
import { useT } from "./i18n";

/** Live counts the tour watches to know when a step's action has been performed. */
export interface OnboardingSignals {
  inline: number; // span (line) comments on the doc
  doc: number; // document-level comments
  answered: number; // comments carrying the human's `selected` answer
  panes: number; // current pane count (changing it satisfies the layout step)
  sourceEdits: number; // edits typed into the source pane
}

type Gate = (now: OnboardingSignals, base: OnboardingSignals) => boolean;

interface Step {
  id: string;
  /** CSS selector of the control to spotlight (a pulsing outline), or null. */
  target: string | null;
  /** Returns true once this step's required action is done; null = no gate. */
  gate: Gate | null;
}

const STEPS: Step[] = [
  { id: "welcome", target: null, gate: null },
  { id: "settings", target: '[data-onboard="settings"]', gate: null },
  { id: "inline", target: '[data-onboard="preview"]', gate: (n, b) => n.inline > b.inline },
  { id: "doc", target: '[data-onboard="preview"]', gate: (n, b) => n.doc > b.doc },
  { id: "answer", target: '[data-onboard="comments"]', gate: (n, b) => n.answered > b.answered },
  { id: "layout", target: '[data-onboard="panes"]', gate: (n, b) => n.panes !== b.panes },
  { id: "source", target: '[data-onboard="source"]', gate: (n, b) => n.sourceEdits > b.sourceEdits },
  // The last two are informational (no gate): triggering them for real would navigate the tour
  // off the throwaway sample (Move to New Doc) or hand the turn to an agent that isn't there
  // (Finish turn), so we spotlight + explain them rather than force the action.
  { id: "movedoc", target: '[data-onboard="preview"]', gate: null },
  { id: "finishturn", target: '[data-onboard="finishturn"]', gate: null },
  { id: "finish", target: null, gate: null },
];

const SPOTLIGHT = "ap-coach-target";

/** The editor the tour runs in. It polices clicks in here, and nowhere else. */
const ROOT = ".ap-app";
/** Surfaces inside the editor that are never a distraction: the coach card, the transient
 *  interaction surfaces a step legitimately leads to, any DIALOG (by any of its spellings), and
 *  the banners that announce something actionable. */
const ALLOW =
  ".ap-coach-card, .ap-ctxmenu, .ap-composer, .ap-profile, .ap-banner, " +
  "[role='dialog'], [role='alertdialog'], dialog, [aria-modal='true']";

/**
 * Is this click a distraction the tour should nudge about? `nodes` is the click's composed path
 * (or just its target when a path isn't available), and `stepTarget` the control the current step
 * points at.
 *
 * The answer only ever decides whether the coach card BLINKS. The tour does not swallow clicks:
 * the card says it is non-blocking, and a guard that cancels events is as blocking as a modal
 * without the backdrop that would admit it. Cancelling is also what let the tour deadlock a user
 * against a consent banner it had no way to recognise — the fix for that was to stop cancelling,
 * not to enumerate every surface worth sparing.
 *
 * Two rules still bound the nudge, because blinking at the wrong moment is noise:
 *
 *  1. Only inside the editor. Anything outside `ROOT` belongs to the host app — its consent
 *     banner, its nav, its toasts — and the tour has no business commenting on those clicks.
 *  2. Inside the editor, a surface that is ASKING the user something is not a distraction: a
 *     dialog by any of its spellings, and the banners that announce something actionable. The
 *     user answering one is not wandering off.
 */
export function distracts(nodes: readonly Element[], stepTarget: Element | null): boolean {
  if (nodes.length === 0) return false; // nothing identifiable to judge — never nudge blind
  if (!nodes.some((n) => n.closest(ROOT))) return false; // the host app's own chrome
  if (nodes.some((n) => n.closest(ALLOW))) return false; // the card, a dialog, an actionable banner
  if (stepTarget && nodes.some((n) => stepTarget.contains(n))) return false; // this step's own control
  return true;
}

export function Onboarding({
  signals,
  onFinish,
  onActiveStep,
}: {
  signals: OnboardingSignals;
  onFinish: () => void;
  /** Notifies the editor which step is active (so it can reveal step-specific UI). */
  onActiveStep?: (stepId: string) => void;
}): JSX.Element {
  const t = useT();
  const [idx, setIdx] = useState(0);
  // Snapshot of the counts when the current step opened — the gate compares against it
  // so "do the action now" means a *new* comment/answer, not one made on an earlier step.
  const [base, setBase] = useState<OnboardingSignals>(signals);
  const signalsRef = useRef(signals);
  signalsRef.current = signals;

  const step = STEPS[idx]!;
  const isLast = idx === STEPS.length - 1;
  const done = step.gate ? step.gate(signals, base) : true;
  const cardRef = useRef<HTMLDivElement>(null);

  // Re-baseline the counts whenever the step changes (capture the latest, not stale).
  useEffect(() => setBase(signalsRef.current), [idx]);

  // Keep the user on the current step by BLINKING the coach card when they wander — and only
  // that. The click itself is never cancelled: the tour runs over a throwaway sample, so there is
  // nothing here to protect by force, and a guard that cancels can trap the user against anything
  // it fails to recognise. `distracts` decides whether to nudge; this effect is the DOM glue.
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Duck-typed, not `instanceof Element`: the path can cross realms (an iframe, a test DOM),
      // and a failed instanceof would quietly empty this list — turning the nudge off, silently.
      const isEl = (n: unknown): n is Element => !!n && typeof (n as Element).closest === "function";
      // The PATH, not the target: a click inside a shadow root (how consent platforms and embedded
      // widgets are built) retargets `e.target` to the shadow HOST, so matching the target alone
      // judges the wrong element.
      const path = (typeof e.composedPath === "function" ? e.composedPath() : []).filter(isEl);
      const nodes = path.length > 0 ? path : [e.target].filter(isEl);
      if (!distracts(nodes, step.target ? document.querySelector(step.target) : null)) return;
      const card = cardRef.current;
      if (card) {
        card.classList.remove("ap-coach-blink");
        void card.offsetWidth; // reflow so the animation restarts on rapid repeats
        card.classList.add("ap-coach-blink");
      }
    };
    // Capture, so the nudge still happens for a click some handler stops on the way up. It only
    // ever reads the event.
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [step.target]);

  // Spotlight the current step's target control with a pulsing outline.
  useEffect(() => {
    const el = step.target ? document.querySelector(step.target) : null;
    el?.classList.add(SPOTLIGHT);
    return () => el?.classList.remove(SPOTLIGHT);
  }, [step.target]);

  // Tell the editor which step is active, so it can reveal step-specific UI (e.g. open the
  // settings menu on the "settings" step so its controls are visible while we explain them).
  useEffect(() => {
    onActiveStep?.(step.id);
  }, [step.id, onActiveStep]);

  const shortcut = `${MOD_KEY}+/`; // shared modifier (⌘ on macOS, Ctrl elsewhere)
  const body = t(`onboarding.${step.id}.body`, step.id === "inline" ? { shortcut } : undefined);

  return (
    <div className="ap-coach" role="region" aria-label={t("onboarding.welcome.title")}>
      <div className="ap-coach-card" ref={cardRef}>
        <div className="ap-coach-progress">{t("onboarding.progress", { n: String(idx + 1), total: String(STEPS.length) })}</div>
        <div className="ap-coach-title">{t(`onboarding.${step.id}.title`)}</div>
        <div className="ap-coach-body">{body}</div>
        {step.gate && done && <div className="ap-coach-ok">✓ {t("onboarding.actionDone")}</div>}
        <div className="ap-coach-actions">
          <button className="ap-link" onClick={onFinish}>
            {t("onboarding.skip")}
          </button>
          <button
            className="ap-primary"
            disabled={!done}
            onClick={() => (isLast ? onFinish() : setIdx((i) => i + 1))}
          >
            {isLast ? t("onboarding.done") : t("onboarding.next")}
          </button>
        </div>
      </div>
    </div>
  );
}
