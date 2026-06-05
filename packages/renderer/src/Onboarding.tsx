// SPDX-License-Identifier: AGPL-3.0-or-later
//
// First-run guided tour. A non-blocking "coach card" walks the user through a
// throwaway sample plan (loaded by AppRoot via an in-memory api), spotlighting the
// real controls — the settings menu, the preview, the comments rail — and letting
// them practice for real. The comment/answer steps gate Next until the user actually
// does the thing (counts come in via `signals`); a Skip link always escapes.

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";

/** Live counts the tour watches to know when a step's action has been performed. */
export interface OnboardingSignals {
  inline: number; // span (line) comments on the doc
  doc: number; // document-level comments
  answered: number; // comments carrying the human's `selected` answer
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
  { id: "finish", target: null, gate: null },
];

const SPOTLIGHT = "ap-coach-target";

export function Onboarding({ signals, onFinish }: { signals: OnboardingSignals; onFinish: () => void }): JSX.Element {
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

  // Re-baseline the counts whenever the step changes (capture the latest, not stale).
  useEffect(() => setBase(signalsRef.current), [idx]);

  // Spotlight the current step's target control with a pulsing outline.
  useEffect(() => {
    const sel = step.target;
    const el = sel ? document.querySelector(sel) : null;
    el?.classList.add(SPOTLIGHT);
    return () => el?.classList.remove(SPOTLIGHT);
  }, [step.target]);

  const shortcut = typeof navigator !== "undefined" && /Mac/i.test(navigator.platform) ? "⌘/" : "Ctrl+/";
  const body = t(`onboarding.${step.id}.body`, step.id === "inline" ? { shortcut } : undefined);

  return (
    <div className="ap-coach" role="region" aria-label={t("onboarding.welcome.title")}>
      <div className="ap-coach-card">
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
