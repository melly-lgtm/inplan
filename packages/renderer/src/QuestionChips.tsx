// SPDX-License-Identifier: AGPL-3.0-or-later

import { useState } from "react";
import type { Question } from "@inplan/core";
import { useT } from "./i18n";

/**
 * Choice-answer UI (FR4). `multiSelect:false` → radio (pick one); `true` →
 * checkboxes (pick any). An always-on "Other" free-text field accompanies them.
 * "Answer" posts the selected labels + the trimmed Other text, then resets.
 */
export function QuestionChips({ question, disabled, onAnswer }: { question: Question; disabled: boolean; onAnswer: (selected: string[], text: string) => void }): JSX.Element {
  const t = useT();
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const toggle = (label: string) => {
    if (question.multiSelect) {
      setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
    } else {
      setSelected([label]);
    }
  };
  return (
    <div className="ap-question">
      {question.choices.map((c) => (
        <label key={c.label} className={`ap-chip${selected.includes(c.label) ? " on" : ""}`}>
          <input type={question.multiSelect ? "checkbox" : "radio"} name={`q-${c.label}`} checked={selected.includes(c.label)} disabled={disabled} onChange={() => toggle(c.label)} />
          {c.label}
          {c.description ? <span className="ap-muted"> — {c.description}</span> : null}
        </label>
      ))}
      <input className="ap-other" placeholder={t("question.other")} value={other} disabled={disabled} onChange={(e) => setOther(e.target.value)} />
      <button
        disabled={disabled || (selected.length === 0 && !other.trim())}
        onClick={() => {
          onAnswer(selected, other.trim());
          setSelected([]);
          setOther("");
        }}
      >
        {t("question.answer")}
      </button>
    </div>
  );
}
