// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import type { Cadence } from "./api";
import { useT } from "./i18n";

/**
 * Bottom status bar. While the agent holds the turn it animates "Agent is
 * thinking …" with fixed-width dots; hovering the indicator reveals a "take back
 * control" button (the stuck-lock escape) when `canTakeBack` — the reveal itself
 * is CSS (`.ap-thinking:hover .ap-takeback`), so the button is always in the DOM.
 */
export function StatusBar({
  cadence,
  status,
  dirty,
  agentThinking,
  canTakeBack,
  onTakeBack,
}: {
  cadence: Cadence;
  status: string;
  dirty: boolean;
  agentThinking: boolean;
  canTakeBack: boolean;
  onTakeBack: () => void;
}): JSX.Element {
  const t = useT();
  const [dots, setDots] = useState(".");
  useEffect(() => {
    if (!agentThinking) return;
    const id = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + " .")), 500);
    return () => clearInterval(id);
  }, [agentThinking]);
  return (
    <footer className="ap-statusbar">
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
        <span>{status || t("status.ready")}</span>
      )}
      <span className="ap-spacer" />
      <span>
        {cadence} {t("status.mode")}
      </span>
      {dirty && <span> · {t("status.unsaved")}</span>}
    </footer>
  );
}
