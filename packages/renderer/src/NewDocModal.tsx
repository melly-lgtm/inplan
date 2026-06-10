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
  exists,
  onPick,
  draftOption,
  onSubmit,
  onCancel,
}: {
  mode: "create" | "move";
  initialTitle: string;
  initialPath: string;
  /** Set once a submit found the target already on disk: shows the warning + (move) the Append
   *  option, so the user links/appends instead of the create silently failing. Null = normal. */
  exists: boolean;
  /** Host file picker, or null when the host can't pick (then no Browse button). */
  onPick: ((suggestedName: string) => Promise<string | null>) | null;
  /** Host-provided (localized) labels for the optional "draft from a prompt" field — shown only in
   *  create mode when present. Absent ⇒ no prompt field (desktop / free / tests). */
  draftOption?: { label: string; placeholder: string } | null;
  /** `append` is honored only when the target exists in move mode: true ⇒ append the blocks to it,
   *  false ⇒ just link to it (drop the local blocks). Ignored for create / new files. `draftPrompt`
   *  (create + draftOption only) asks the host to agent-draft the new doc from this prompt. */
  onSubmit: (title: string, path: string, opts: { append: boolean; draftPrompt?: string }) => void;
  onCancel: () => void;
}): JSX.Element {
  const t = useT();
  const [title, setTitle] = useState(initialTitle);
  const [path, setPath] = useState(initialPath);
  const [append, setAppend] = useState(true); // default to the non-destructive choice
  const [prompt, setPrompt] = useState(""); // optional "draft from a prompt" (create + draftOption)
  const ref = useRef<HTMLDivElement>(null);
  const showDraft = mode === "create" && !!draftOption;

  useEffect(() => ref.current?.querySelector<HTMLInputElement>("input")?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  const ok = title.trim().length > 0 && path.trim().length > 0;
  const submit = () => ok && onSubmit(title.trim(), path.trim(), { append, ...(showDraft && prompt.trim() ? { draftPrompt: prompt.trim() } : {}) });
  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") submit();
  };
  // The primary action label: a new file creates/moves; an existing one links (or, for a move with
  // Append checked, appends the blocks into it).
  const actionLabel = !exists ? t(mode === "move" ? "newdoc.move" : "newdoc.create") : mode === "move" && append ? t("newdoc.append") : t("newdoc.linkExisting");

  return (
    <div className="ap-modal-backdrop" onMouseDown={onCancel}>
      <div className="ap-modal ap-newdoc" role="dialog" aria-modal="true" aria-label={t(mode === "move" ? "newdoc.moveTitle" : "newdoc.createTitle")} ref={ref} onMouseDown={(e) => e.stopPropagation()}>
        <div className="ap-newdoc-title">{t(mode === "move" ? "newdoc.moveTitle" : "newdoc.createTitle")}</div>
        <label className="ap-newdoc-field">
          <span>{t("newdoc.titleLabel")}</span>
          <input value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={onEnter} />
        </label>
        {/* Not a <label> wrapper here: it also contains the Browse button, and wrapping a button in a
            label folds the label text into the button's accessible name. Use an aria-label instead. */}
        <div className="ap-newdoc-field">
          <span>{t("newdoc.location")}</span>
          <div className="ap-newdoc-path">
            <input aria-label={t("newdoc.location")} value={path} onChange={(e) => setPath(e.target.value)} onKeyDown={onEnter} />
            {onPick && (
              <button type="button" className="ap-link" onClick={async () => { const p = await onPick(path); if (p) setPath(p); }}>
                {t("newdoc.browse")}
              </button>
            )}
          </div>
        </div>
        {showDraft && (
          <label className="ap-newdoc-field ap-newdoc-draft">
            <span>{draftOption!.label}</span>
            <textarea className="ap-newdoc-prompt" rows={3} placeholder={draftOption!.placeholder} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          </label>
        )}
        {exists && (
          <div className="ap-newdoc-exists" role="alert">
            <div className="ap-newdoc-warn">{t("newdoc.exists")}</div>
            {mode === "move" ? (
              <label className="ap-newdoc-append">
                <input type="checkbox" checked={append} onChange={(e) => setAppend(e.target.checked)} />
                <span>{t("newdoc.appendExisting")}</span>
              </label>
            ) : (
              <div className="ap-newdoc-warn-sub">{t("newdoc.willLink")}</div>
            )}
          </div>
        )}
        <div className="ap-newdoc-actions">
          <button className="ap-link" onClick={onCancel}>
            {t("quit.cancel")}
          </button>
          <button className="ap-primary" disabled={!ok} onClick={submit}>
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
