// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef } from "react";
import { useT } from "./i18n";

/**
 * "Document limit reached" — shown when creating/moving a doc would exceed the host's active-document
 * cap. Offers to deactivate the least-recently-used doc to make room. Confirming resolves the
 * create()'s pending promise true (deactivate + create); Cancel/Escape/backdrop resolve false — a
 * strict no-op, nothing is deactivated or created. Mirrors {@link QuitDialog}'s focus + Escape
 * handling so keyboard input can't fall through to the new-doc flow still mounted underneath.
 */
export function CapLimitDialog({
  limit,
  lruTitle,
  onConfirm,
  onCancel,
}: {
  limit: number;
  lruTitle: string;
  onConfirm: () => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);

  // Focus the Cancel action on mount: deactivation is destructive, so Enter should default to the
  // safe choice (and focus is trapped here rather than the underlying Create button).
  useEffect(() => ref.current?.querySelector<HTMLButtonElement>(".ap-link")?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return (
    <div className="ap-modal-backdrop" onMouseDown={onCancel}>
      <div className="ap-modal ap-quit" role="dialog" aria-modal="true" aria-label={t("newdoc.limitTitle")} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ap-quit-title">{t("newdoc.limitTitle")}</div>
        <p className="ap-quit-body">{t("newdoc.limitBody", { limit: String(limit), title: lruTitle })}</p>
        <div className="ap-quit-actions">
          <button className="ap-link" onClick={onCancel}>
            {t("quit.cancel")}
          </button>
          <button className="ap-primary" onClick={onConfirm}>
            {t("newdoc.deactivateAndCreate")}
          </button>
        </div>
      </div>
    </div>
  );
}
