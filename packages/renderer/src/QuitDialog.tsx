// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";

/**
 * "Do you want to quit?" — shown on desktop window-close and on web "Back". The latest content is
 * always saved on quit (no manual save prompt), so the only choice offered is the opt-in "switch
 * agent to build mode" toggle (default off). Confirming calls back with that flag; the host saves
 * the latest content and leaves.
 */
export function QuitDialog({
  onQuit,
  onCancel,
}: {
  onQuit: (opts: { startBuild: boolean }) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [build, setBuild] = useState(false); // default off — explicit hand-off to implementation
  const ref = useRef<HTMLDivElement>(null);

  // Focus the primary action so Enter confirms the quit (and Space toggles a focused box).
  useEffect(() => ref.current?.querySelector<HTMLButtonElement>(".ap-primary")?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="ap-modal-backdrop" onMouseDown={onCancel}>
      <div className="ap-modal ap-quit" role="dialog" aria-modal="true" aria-label={t("quit.title")} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ap-quit-title">{t("quit.title")}</div>
        <div className="ap-quit-opts">
          <label className="ap-quit-opt">
            <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} />
            {t("quit.startBuild")}
          </label>
        </div>
        <div className="ap-quit-actions">
          <button className="ap-link" onClick={onCancel}>
            {t("quit.cancel")}
          </button>
          <button className="ap-primary" onClick={() => onQuit({ startBuild: build })}>
            {t("quit.quit")}
          </button>
        </div>
      </div>
    </div>
  );
}
