// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { MOD_KEY } from "./platform";
import { IconComment, IconMemo } from "./Icons";

/**
 * Floating comment composer. Multi-line textarea that grows to 8 lines;
 * ⌘/Ctrl+Enter (or the Comment button) submits the trimmed text; cancel (or
 * clicking outside while empty) closes it. The header is a drag handle.
 */
export function ComposerPopover({
  target,
  pos,
  disabled,
  onSubmit,
  onClose,
}: {
  target: string | null;
  pos: { x: number; y: number };
  disabled: boolean;
  onSubmit: (text: string, talkToAgent: boolean) => void;
  onClose: () => void;
}): JSX.Element {
  const t = useT();
  const [text, setText] = useState("");
  // The comment's audience: talk to the agent (default — feeds + wakes the agent) or leave a memo
  // (the agent ignores it). A bistate switch: conversation on the left, memo on the right.
  const [talkToAgent, setTalkToAgent] = useState(true);
  const [p, setP] = useState(pos);
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    ta.current?.focus();
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) setP({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
    };
    const up = () => {
      drag.current = null;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !text.trim()) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [text, onClose]);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22)}px`;
  };

  const submit = () => {
    if (text.trim()) onSubmit(text.trim(), talkToAgent);
  };

  return (
    <div className="ap-composer ap-composer-float" ref={box} style={{ left: p.x, top: p.y, right: "auto" }}>
      <div className="ap-composer-head" onMouseDown={(e) => (drag.current = { dx: e.clientX - p.x, dy: e.clientY - p.y })}>
        <span className="ap-quote">{target ? t("composer.on", { target }) : t("composer.docLevel")}</span>
        <span className="ap-drag" title={t("composer.dragToMove")}>⠿</span>
      </div>
      <textarea
        ref={ta}
        className="ap-grow"
        placeholder={t("composer.placeholder", { mod: MOD_KEY })}
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="ap-row">
        {/* Audience switch: conversation (talk to the agent — default) ⇄ memo (the agent ignores it). */}
        <span className="ap-agent-toggle" role="radiogroup" aria-label={t("composer.audience")}>
          <button
            type="button"
            className={`ap-agent-opt${talkToAgent ? " active" : ""}`}
            role="radio"
            aria-checked={talkToAgent}
            title={t("composer.talkToAgent")}
            aria-label={t("composer.talkToAgent")}
            disabled={disabled}
            onClick={() => setTalkToAgent(true)}
          >
            <IconComment />
          </button>
          <button
            type="button"
            className={`ap-agent-opt${!talkToAgent ? " active" : ""}`}
            role="radio"
            aria-checked={!talkToAgent}
            title={t("composer.leaveMemo")}
            aria-label={t("composer.leaveMemo")}
            disabled={disabled}
            onClick={() => setTalkToAgent(false)}
          >
            <IconMemo />
          </button>
        </span>
        <button onClick={submit} disabled={disabled || !text.trim()}>
          {t("composer.comment")}
        </button>
        <button className="ap-link" onClick={onClose}>
          {t("composer.cancel")}
        </button>
      </div>
    </div>
  );
}
