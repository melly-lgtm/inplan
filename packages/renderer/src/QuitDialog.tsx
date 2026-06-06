// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";

/**
 * "Do you want to quit?" — shown on desktop window-close and on web "Back". Offers an
 * optional Save (only when there are unsaved changes, default-checked) and an opt-in
 * "switch agent to build mode" toggle (default off). Confirming calls back with the
 * chosen flags; the host does the work.
 */
export function QuitDialog({
  fileName,
  dirty,
  onQuit,
  onCancel,
}: {
  fileName: string | null;
  dirty: boolean;
  onQuit: (opts: { save: boolean; startBuild: boolean }) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [save, setSave] = useState(true); // default checked (only rendered when dirty)
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
          {dirty && (
            <label className="ap-quit-opt">
              <input type="checkbox" checked={save} onChange={(e) => setSave(e.target.checked)} />
              {t("quit.save", { file: fileName ?? t("quit.thisDoc") })}
            </label>
          )}
          <label className="ap-quit-opt">
            <input type="checkbox" checked={build} onChange={(e) => setBuild(e.target.checked)} />
            {t("quit.startBuild")}
          </label>
        </div>
        <div className="ap-quit-actions">
          <button className="ap-link" onClick={onCancel}>
            {t("quit.cancel")}
          </button>
          <button className="ap-primary" onClick={() => onQuit({ save: dirty && save, startBuild: build })}>
            {t("quit.quit")}
          </button>
        </div>
      </div>
    </div>
  );
}
