// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";

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
  onSubmit: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
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
    if (text.trim()) onSubmit(text.trim());
  };

  return (
    <div className="ap-composer ap-composer-float" ref={box} style={{ left: p.x, top: p.y, right: "auto" }}>
      <div className="ap-composer-head" onMouseDown={(e) => (drag.current = { dx: e.clientX - p.x, dy: e.clientY - p.y })}>
        <span className="ap-quote">{target ? `on “${target}”` : "document-level comment"}</span>
        <span className="ap-drag" title="drag to move">⠿</span>
      </div>
      <textarea
        ref={ta}
        className="ap-grow"
        placeholder="Add a comment…  (⌘/Ctrl+Enter to submit)"
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
        <button onClick={submit} disabled={disabled || !text.trim()}>
          Comment
        </button>
        <button className="ap-link" onClick={onClose}>
          cancel
        </button>
      </div>
    </div>
  );
}
