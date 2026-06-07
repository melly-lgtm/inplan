// SPDX-License-Identifier: AGPL-3.0-or-later

import { useEffect, useRef, useState } from "react";
import { useT } from "./i18n";

/**
 * Modal for the Create Doc / Move Text to New Doc actions: collect a title and a file location
 * (pre-filled from the selection), with a Browse button that defers to the host's file picker.
 * Confirming calls back with the chosen title + path; the host creates the file and the caller
 * rewrites the selection into a link.
 */
export function NewDocModal({
  mode,
  initialTitle,
  initialPath,
  onPick,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "move";
  initialTitle: string;
  initialPath: string;
  /** Host file picker, or null when the host can't pick (then no Browse button). */
  onPick: ((suggestedName: string) => Promise<string | null>) | null;
  onSubmit: (title: string, path: string) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [path, setPath] = useState(initialPath);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => ref.current?.querySelector<HTMLInputElement>("input")?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const ok = title.trim().length > 0 && path.trim().length > 0;
  const submit = () => ok && onSubmit(title.trim(), path.trim());
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div className="ap-modal-backdrop" onMouseDown={onCancel}>
      <div className="ap-modal ap-newdoc" role="dialog" aria-modal="true" aria-label={t(mode === "move" ? "newdoc.moveTitle" : "newdoc.createTitle")} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ap-newdoc-title">{t(mode === "move" ? "newdoc.moveTitle" : "newdoc.createTitle")}</div>
        <label className="ap-newdoc-field">
          <span>{t("newdoc.titleLabel")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onEnter} />
        </label>
        <label className="ap-newdoc-field">
          <span>{t("newdoc.location")}</span>
          <div className="ap-newdoc-path">
            <input value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={onEnter} />
            {onPick && (
              <button type="button" className="ap-link" onClick={async () => { const p = await onPick(path); if (p) setPath(p); }}>
                {t("newdoc.browse")}
              </button>
            )}
          </div>
        </label>
        <div className="ap-newdoc-actions">
          <button className="ap-link" onClick={onCancel}>
            {t("quit.cancel")}
          </button>
          <button className="ap-primary" disabled={!ok} onClick={submit}>
            {t(mode === "move" ? "newdoc.move" : "newdoc.create")}
          </button>
        </div>
      </div>
    </div>
  );
}
