// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure text-edit functions behind the source pane's toolbar (App.tsx's SourceToolbar).
// Each takes the full doc text plus a [from,to) selection and returns a CodeMirror-shaped
// {changes, selection} — kept pure/DOM-free so the toggle logic is unit-testable without
// mounting CodeMirror; SourceEditor.tsx just dispatches what these return.

export interface TextEdit {
  changes: { from: number; to: number; insert: string };
  selection: { anchor: number; head?: number };
}

/** Markdown ATX heading prefix, e.g. "### " — shared with SourceToolbar.tsx's heading picker. */
export const ATX = /^(#{1,6})\s+/;

function lineBounds(text: string, from: number, to: number): { start: number; end: number } {
  const start = text.lastIndexOf("\n", from - 1) + 1;
  let end = text.indexOf("\n", Math.max(to - 1, start));
  if (end === -1) end = text.length;
  return { start, end };
}

/** Set (or, clicking the active level again, clear) the ATX heading level of the cursor's line. */
export function headingEdit(text: string, pos: number, level: number): TextEdit {
  const { start, end } = lineBounds(text, pos, pos);
  const line = text.slice(start, end);
  const m = ATX.exec(line);
  const currentLevel = m?.[1]?.length ?? 0;
  const rest = m ? line.slice(m[0].length) : line;
  const nextLevel = currentLevel === level ? 0 : level; // clicking the active level clears it
  const prefix = nextLevel > 0 ? "#".repeat(nextLevel) + " " : "";
  const insert = prefix + rest;
  return { changes: { from: start, to: end, insert }, selection: { anchor: start + insert.length } };
}

/** Toggle an inline marker pair (bold **, italic _, strikethrough ~~, inline code `) around the
 *  selection. With no selection, inserts an empty pair and places the cursor between them.
 *  Toggling off recognizes the markers whether they're inside the selection or just outside it. */
export function wrapEdit(text: string, from: number, to: number, open: string, close: string = open): TextEdit {
  if (from === to) {
    return { changes: { from, to, insert: open + close }, selection: { anchor: from + open.length } };
  }
  const selected = text.slice(from, to);
  if (selected.startsWith(open) && selected.endsWith(close) && selected.length >= open.length + close.length) {
    const inner = selected.slice(open.length, selected.length - close.length);
    return { changes: { from, to, insert: inner }, selection: { anchor: from, head: from + inner.length } };
  }
  const before = text.slice(Math.max(0, from - open.length), from);
  const after = text.slice(to, to + close.length);
  if (before === open && after === close) {
    return { changes: { from: from - open.length, to: to + close.length, insert: selected }, selection: { anchor: from - open.length, head: from - open.length + selected.length } };
  }
  return { changes: { from, to, insert: open + selected + close }, selection: { anchor: from + open.length, head: from + open.length + selected.length } };
}

/** Toggle a literal line prefix (blockquote "> ", bullet "- ", checklist "- [ ] ") across every
 *  line the selection spans. Adds it unless every spanned line already has it, in which case it
 *  strips it from all of them. Blank lines are left untouched WITHIN a multi-line span (so
 *  intentional paragraph breaks in a selection survive), but a single blank line under the
 *  cursor is a normal target — that's how you start a fresh list/quote line.
 *
 *  `prefixPattern`, if given, is used instead of a literal `startsWith(prefix)` to detect an
 *  existing prefix — the checklist call site needs this to recognize "- [x] " (checked) as well
 *  as "- [ ] ", so re-toggling a checked item strips it instead of stacking another prefix. */
export function linePrefixEdit(text: string, from: number, to: number, prefix: string, prefixPattern?: RegExp): TextEdit {
  const { start, end } = lineBounds(text, from, to);
  const lines = text.slice(start, end).split("\n");
  const skipBlank = lines.length > 1;
  const targetable = lines.filter((l) => !(skipBlank && l.length === 0));
  const matchLen = (l: string): number | null => {
    if (prefixPattern) {
      const m = prefixPattern.exec(l);
      return m ? m[0].length : null;
    }
    return l.startsWith(prefix) ? prefix.length : null;
  };
  const allPrefixed = targetable.length > 0 && targetable.every((l) => matchLen(l) !== null);
  const insert = lines
    .map((l) => {
      if (skipBlank && l.length === 0) return l;
      const len = matchLen(l);
      if (allPrefixed) return len !== null ? l.slice(len) : l;
      return len !== null ? l : prefix + l;
    })
    .join("\n");
  // A collapsed cursor at the end, not a selection over the whole result: a selection here
  // meant the very next keystroke (typing the list item's text) replaced the prefix it just
  // inserted instead of continuing after it.
  return { changes: { from: start, to: end, insert }, selection: { anchor: start + insert.length } };
}

/** Toggle sequential "1. "/"2. "/… numbering across the selection's spanned lines (same
 *  blank-line handling as linePrefixEdit). */
export function orderedListEdit(text: string, from: number, to: number): TextEdit {
  const { start, end } = lineBounds(text, from, to);
  const lines = text.slice(start, end).split("\n");
  const skipBlank = lines.length > 1;
  const targetable = lines.filter((l) => !(skipBlank && l.length === 0));
  const allNumbered = targetable.length > 0 && targetable.every((l) => /^\d+\.\s/.test(l));
  let n = 1;
  const insert = lines
    .map((l) => {
      if (skipBlank && l.length === 0) return l;
      if (allNumbered) return l.replace(/^\d+\.\s/, "");
      return `${n++}. ${l.replace(/^\d+\.\s/, "")}`;
    })
    .join("\n");
  // Collapsed cursor at the end (see linePrefixEdit) — not a selection the next keystroke
  // would replace.
  return { changes: { from: start, to: end, insert }, selection: { anchor: start + insert.length } };
}

/** Toggle a fenced ``` code block around the selection (an empty selection opens an empty one
 *  with the cursor inside). */
export function codeBlockEdit(text: string, from: number, to: number): TextEdit {
  const fence = "```";
  const selected = text.slice(from, to);
  if (selected.startsWith(fence + "\n") && selected.endsWith("\n" + fence)) {
    const inner = selected.slice(fence.length + 1, selected.length - fence.length - 1);
    return { changes: { from, to, insert: inner }, selection: { anchor: from, head: from + inner.length } };
  }
  if (from === to) {
    return { changes: { from, to, insert: `${fence}\n\n${fence}` }, selection: { anchor: from + fence.length + 1 } };
  }
  return {
    changes: { from, to, insert: `${fence}\n${selected}\n${fence}` },
    selection: { anchor: from + fence.length + 1, head: from + fence.length + 1 + selected.length },
  };
}

/** Insert a horizontal rule, padded with blank lines so it can't be misread as a Setext heading
 *  underline for whatever paragraph precedes it. */
export function horizontalRuleEdit(text: string, from: number, to: number): TextEdit {
  const insert = "\n\n---\n\n";
  return { changes: { from, to, insert }, selection: { anchor: from + insert.length } };
}

/** Insert a Markdown link. The selection becomes the link text (or "text" as a placeholder);
 *  either way the inserted "url" placeholder ends up selected, ready to type/paste over. */
export function linkEdit(text: string, from: number, to: number): TextEdit {
  const label = from === to ? "text" : text.slice(from, to);
  const url = "url";
  const insert = `[${label}](${url})`;
  const urlStart = from + 1 + label.length + 2;
  return { changes: { from, to, insert }, selection: { anchor: urlStart, head: urlStart + url.length } };
}

/** Insert `![](<relPath>)` for an image (pasted or picked via a file dialog) at the cursor,
 *  replacing any selection. Unlike linkEdit, `relPath` is already final — it came from saving
 *  the file, not a placeholder to fill in — so the cursor just lands right after it.
 *  The angle-bracket destination form (rather than bare `![](relPath)`) is required, not
 *  cosmetic: `relPath` is `<docname>.assets/…`, and a doc named e.g. "Product Plan.md" makes
 *  that a path with a space — which markdown-it's bare (unbracketed) destination syntax can't
 *  parse as a link at all, so the image would silently fail to render. `<...>` allows spaces
 *  and parens; markdown.ts's image-src resolver decodes it back to the literal path. */
export function imageEdit(text: string, from: number, to: number, relPath: string): TextEdit {
  const insert = `![](<${relPath}>)`;
  return { changes: { from, to, insert }, selection: { anchor: from + insert.length } };
}
