// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Blog-editor-style formatting toolbar above the Source pane's CodeMirror editor: a heading
// picker plus bold/italic/strikethrough/quote/lists/link/code buttons. Each button drives an
// imperative command on SourceEditorHandle (see SourceEditor.tsx + markdownEdits.ts); the
// toolbar itself holds no document state beyond the heading dropdown's open/closed flag.

import { useRef, useState, type RefObject } from "react";
import { useT } from "./i18n";
import { ContextMenu } from "./ContextMenu";
import type { SourceEditorHandle } from "./SourceEditor";
import {
  IconBold,
  IconBulletList,
  IconChecklist,
  IconCodeBlock,
  IconHorizontalRule,
  IconInlineCode,
  IconItalic,
  IconLink,
  IconQuote,
  IconStrikethrough,
} from "./Icons";

const ATX = /^(#{1,6})\s+/;

export function SourceToolbar({
  editorRef,
  body,
  activeLine,
  disabled,
}: {
  editorRef: RefObject<SourceEditorHandle>;
  body: string;
  activeLine: number | null;
  disabled: boolean;
}): JSX.Element {
  const t = useT();
  const headingBtnRef = useRef<HTMLButtonElement>(null);
  const [headingMenuOpen, setHeadingMenuOpen] = useState(false);

  const line = activeLine != null ? (body.split("\n")[activeLine] ?? "") : "";
  const currentLevel = ATX.exec(line)?.[1]?.length ?? 0;

  const headingItems = [
    { level: 0, label: t("source.paragraph") },
    { level: 1, label: t("source.h1") },
    { level: 2, label: t("source.h2") },
    { level: 3, label: t("source.h3") },
    { level: 4, label: t("source.h4") },
    { level: 5, label: t("source.h5") },
    { level: 6, label: t("source.h6") },
  ].map(({ level, label }) => ({
    label: currentLevel === level ? `✓ ${label}` : label,
    onSelect: () => editorRef.current?.setHeading(level),
  }));

  return (
    <div className="ap-src-toolbar">
      <div className="ap-seg">
        <button ref={headingBtnRef} className={currentLevel > 0 ? "active" : ""} disabled={disabled} title={t("source.headingTitle")} onClick={() => setHeadingMenuOpen((o) => !o)}>
          {currentLevel > 0 ? `${t("source.heading")}${currentLevel}` : t("source.heading")}
        </button>
      </div>
      {headingMenuOpen && headingBtnRef.current && (
        <ContextMenu
          pos={{ x: headingBtnRef.current.getBoundingClientRect().left, y: headingBtnRef.current.getBoundingClientRect().bottom + 4 }}
          items={headingItems}
          onClose={() => setHeadingMenuOpen(false)}
        />
      )}

      <div className="ap-seg">
        <button disabled={disabled} title={t("source.bold")} onClick={() => editorRef.current?.toggleBold()}><IconBold /></button>
        <button disabled={disabled} title={t("source.italic")} onClick={() => editorRef.current?.toggleItalic()}><IconItalic /></button>
        <button disabled={disabled} title={t("source.strikethrough")} onClick={() => editorRef.current?.toggleStrikethrough()}><IconStrikethrough /></button>
      </div>

      <div className="ap-seg">
        <button disabled={disabled} title={t("source.hr")} onClick={() => editorRef.current?.insertHorizontalRule()}><IconHorizontalRule /></button>
        <button disabled={disabled} title={t("source.quote")} onClick={() => editorRef.current?.toggleBlockquote()}><IconQuote /></button>
      </div>

      <div className="ap-seg">
        <button disabled={disabled} title={t("source.bulletList")} onClick={() => editorRef.current?.toggleBulletList()}><IconBulletList /></button>
        <button disabled={disabled} title={t("source.orderedList")} onClick={() => editorRef.current?.toggleOrderedList()}>1.</button>
        <button disabled={disabled} title={t("source.checklist")} onClick={() => editorRef.current?.toggleChecklist()}><IconChecklist /></button>
      </div>

      <div className="ap-seg">
        <button disabled={disabled} title={t("source.link")} onClick={() => editorRef.current?.insertLink()}><IconLink /></button>
        <button disabled={disabled} title={t("source.inlineCode")} onClick={() => editorRef.current?.toggleInlineCode()}><IconInlineCode /></button>
        <button disabled={disabled} title={t("source.codeBlock")} onClick={() => editorRef.current?.toggleCodeBlock()}><IconCodeBlock /></button>
      </div>
    </div>
  );
}
