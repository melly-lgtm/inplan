// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";
import { RelativeTime } from "./RelativeTime";
import { renderInline } from "./inlineMarkup";

/**
 * Bottom status bar. While the agent holds the turn it animates "Agent is
 * thinking …" with fixed-width dots; hovering the indicator reveals a "take back
 * control" button (the stuck-lock escape) when `canTakeBack` — the reveal itself
 * is CSS (`.ap-thinking:hover .ap-takeback`), so the button is always in the DOM.
 *
 * When the agent has relayed notes (`inplan message`), the latest is shown as a
 * clickable chip; clicking opens a scrollable popup with the full session history.
 */
export function StatusBar({
  modeLabelKey,
  status,
  dirty,
  agentThinking,
  messages,
  canTakeBack,
  onTakeBack,
}: {
  modeLabelKey: string;
  status: string;
  dirty: boolean;
  agentThinking: boolean;
  messages: { text: string; ts: string }[];
  canTakeBack: boolean;
  onTakeBack: () => void;
}): JSX.Element {
  const t = useT();
  const [dots, setDots] = useState(".");
  // The window has two internal modes: "auto" tracks the turn (open while the agent holds it,
  // closed on the user's turn); "closed" stays shut. Opening it manually flips back to auto.
  const [mode, setMode] = useState<"auto" | "closed">("auto");
  const [open, setOpen] = useState(agentThinking); // seed from the turn (mount during an agent turn ⇒ open)
  const msgRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const prevThinking = useRef(agentThinking);

  useEffect(() => {
    if (!agentThinking) return;
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + " .")), 500);
    return () => clearInterval(id);
  }, [agentThinking]);

  // Close the messages popup on any outside click (an explicit dismiss → "closed" mode, so it
  // won't auto-reopen until the user opens it again).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (msgRef.current && !msgRef.current.contains(e.target as Node)) {
        setOpen(false);
        setMode("closed");
      }
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  // Auto mode: the window follows the turn — open when the agent STARTS working, close when it's
  // the user's turn. We act only on a real `agentThinking` transition (tracked via a ref), not on
  // a mode flip — so manually reopening the window during the user's turn isn't instantly undone.
  useEffect(() => {
    const turnChanged = prevThinking.current !== agentThinking;
    prevThinking.current = agentThinking;
    if (mode === "auto" && turnChanged) setOpen(agentThinking);
  }, [agentThinking, mode]);

  // Newest message sits at the bottom; keep the list pinned there as it opens / grows.
  useEffect(() => {
    if (open && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [open, messages.length]);

  const latest = messages.at(-1);

  return (
    <footer className="ap-statusbar">
      {/* LEFT: current mode, then the status message (or "Agent is thinking…"). */}
      <span className="ap-status-mode">
        {t(modeLabelKey)} {t("status.mode")}
      </span>
      <span className="ap-status-sep" aria-hidden="true">|</span>
      {agentThinking ? (
        <span className="ap-thinking" title={t("status.thinkingTitle")}>
          {t("status.thinking")} <span className="ap-dots">{dots}</span>
          {canTakeBack && (
            <button className="ap-takeback" onClick={onTakeBack} title={t("status.takeBackTitle")}>
              {t("status.takeBack")}
            </button>
          )}
        </span>
      ) : (
        <span className="ap-status-msg">{status || t("status.ready")}</span>
      )}
      {dirty && <span className="ap-status-dirty"> · {t("status.unsaved")}</span>}

      <span className="ap-spacer" />

      {/* RIGHT: the agent's relayed-message history. */}
      {latest && (
        <div className="ap-agentmsg" ref={msgRef}>
          <button
            className="ap-agentmsg-latest"
            onClick={() => {
              // Opening the window puts it in auto mode; closing it puts it in "closed".
              if (open) {
                setOpen(false);
                setMode("closed");
              } else {
                setOpen(true);
                setMode("auto");
              }
            }}
            title={t("status.agentMessages")}
            aria-expanded={open}
          >
            <span aria-hidden="true">💬</span> {latest.text}
          </button>
          {open && (
            <div className="ap-agentmsg-pop ap-agentmsg-pop--right" role="dialog" aria-label={t("status.agentMessages")}>
              <div className="ap-agentmsg-head">{t("status.agentMessages")}</div>
              <div className="ap-agentmsg-list" ref={listRef}>
                {/* Chronological — newest at the bottom (like a terminal log). */}
                {messages.map((m, i) => (
                  <div className="ap-agentmsg-item" key={`${m.ts}-${i}`}>
                    <RelativeTime iso={m.ts} className="ap-agentmsg-time" />
                    <div className="ap-agentmsg-text">{renderInline(m.text)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </footer>
  );
}
