// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useState } from "react";
import type { Cadence } from "./api";

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
  const [dots, setDots] = useState(".");
  useEffect(() => {
    if (!agentThinking) return;
    const t = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + " .")), 500);
    return () => clearInterval(t);
  }, [agentThinking]);
  return (
    <footer className="ap-statusbar">
      {agentThinking ? (
        <span className="ap-thinking" title="Agent is working. Hover to take back control if it's not responding.">
          Agent is thinking <span className="ap-dots">{dots}</span>
          {canTakeBack && (
            <button className="ap-takeback" onClick={onTakeBack} title="The agent hasn't handed control back. Reclaim the turn and keep editing.">
              not responding? take back control
            </button>
          )}
        </span>
      ) : (
        <span>{status || "ready"}</span>
      )}
      <span className="ap-spacer" />
      <span>{cadence} mode</span>
      {dirty && <span> · unsaved</span>}
    </footer>
  );
}
