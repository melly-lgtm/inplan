// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import type { Cadence } from "./api";
import { useT } from "./i18n";

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
  cadence,
  status,
  dirty,
  agentThinking,
  messages,
  canTakeBack,
  onTakeBack,
}: {
  cadence: Cadence;
  status: string;
  dirty: boolean;
  agentThinking: boolean;
  messages: { text: string; ts: string }[];
  canTakeBack: boolean;
  onTakeBack: () => void;
}): JSX.Element {
  const t = useT();
  const [dots, setDots] = useState(".");
  const [open, setOpen] = useState(false);
  const msgRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!agentThinking) return;
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + " .")), 500);
    return () => clearInterval(id);
  }, [agentThinking]);

  // Close the messages popup on any outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (msgRef.current && !msgRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const latest = messages.at(-1);

  return (
    <footer className="ap-statusbar">
      {/* LEFT: current mode, then the status message (or "Agent is thinking…"). */}
      <span className="ap-status-mode">
        {t(cadence === "instant" ? "topbar.instant" : "topbar.turn")} {t("status.mode")}
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
          <button className="ap-agentmsg-latest" onClick={() => setOpen((v) => !v)} title={t("status.agentMessages")} aria-expanded={open}>
            <span aria-hidden="true">💬</span> {latest.text}
          </button>
          {open && (
            <div className="ap-agentmsg-pop ap-agentmsg-pop--right" role="dialog" aria-label={t("status.agentMessages")}>
              <div className="ap-agentmsg-head">{t("status.agentMessages")}</div>
              <div className="ap-agentmsg-list">
                {messages
                  .slice()
                  .reverse()
                  .map((m, i) => (
                    <div className="ap-agentmsg-item" key={`${m.ts}-${i}`}>
                      <div className="ap-agentmsg-time">{m.ts.slice(0, 16).replace("T", " ")}</div>
                      <div className="ap-agentmsg-text">{m.text}</div>
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
