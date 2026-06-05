// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import type { Question } from "@inplan/core";
import { useT } from "./i18n";

/**
 * Choice-answer UI (FR4). `multiSelect:false` → radio (pick one); `true` →
 * checkboxes (pick any). An always-on "Other" free-text field accompanies them.
 *
 * Once the thread has been answered (`answered` is the persisted selection), the
 * picker settles into a read-only result: the chosen chips stay checked and the
 * unchosen ones fold away behind a "show N more" toggle (they survive reload because
 * `answered` comes from the stored answer reply, not local state). "Change answer"
 * reopens the interactive picker, pre-filled with the current choice.
 */
export function QuestionChips({
  question,
  disabled,
  answered = null,
  onAnswer,
}: {
  question: Question;
  disabled: boolean;
  answered?: string[] | null;
  onAnswer: (selected: string[], text: string) => void;
}): JSX.Element {
  const t = useT();
  const isAnswered = answered != null && answered.length > 0;
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<string[]>(answered ?? []);
  const [other, setOther] = useState("");
  const [expanded, setExpanded] = useState(false);

  const picking = !isAnswered || editing; // interactive picker vs. settled result
  const settled = answered ?? [];
  const hiddenCount = picking ? 0 : question.choices.filter((c) => !settled.includes(c.label)).length;

  const toggle = (label: string) => {
    if (question.multiSelect) {
      setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
    } else {
      setSelected([label]);
    }
  };

  return (
    <div className="ap-question">
      {question.choices.map((c) => {
        const on = picking ? selected.includes(c.label) : settled.includes(c.label);
        // Settled view: render only the chosen chips unless the user expands the rest.
        if (!picking && !on && !expanded) return null;
        return (
          <label key={c.label} className={`ap-chip${on ? " on" : ""}${picking ? "" : " ap-chip-static"}`}>
            <input
              type={question.multiSelect ? "checkbox" : "radio"}
              name={`q-${c.label}`}
              checked={on}
              disabled={disabled || !picking}
              onChange={() => toggle(c.label)}
            />
            {c.label}
            {c.description ? <span className="ap-muted"> — {c.description}</span> : null}
          </label>
        );
      })}

      {!picking && hiddenCount > 0 && (
        <button type="button" className="ap-link ap-chip-toggle" onClick={() => setExpanded((v) => !v)}>
          {expanded ? t("question.showLess") : t("question.showMore", { n: hiddenCount })}
        </button>
      )}

      {picking ? (
        <>
          <input className="ap-other" placeholder={t("question.other")} value={other} disabled={disabled} onChange={(e) => setOther(e.target.value)} />
          <div className="ap-row">
            <button
              disabled={disabled || (selected.length === 0 && !other.trim())}
              onClick={() => {
                onAnswer(selected, other.trim());
                setOther("");
                setEditing(false);
                setExpanded(false);
              }}
            >
              {t("question.answer")}
            </button>
            {isAnswered && (
              <button
                className="ap-link"
                onClick={() => {
                  setEditing(false);
                  setSelected(answered ?? []);
                  setOther("");
                }}
              >
                {t("thread.cancel")}
              </button>
            )}
          </div>
        </>
      ) : (
        !disabled && (
          <button
            type="button"
            className="ap-link ap-chip-change"
            onClick={() => {
              setSelected(answered ?? []);
              setEditing(true);
            }}
          >
            {t("question.change")}
          </button>
        )
      )}
    </div>
  );
}
