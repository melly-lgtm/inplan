// SPDX-License-Identifier: AGPL-3.0-or-later

import { insertNewlineContinueMarkupCommand, markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { Comment } from "@inplan/core";
import type { EditorBinding } from "./api";
import { buildClipHtml, readClipHtml, type ClipboardPayload } from "./clipboard";
import {
  codeBlockEdit,
  headingEdit,
  horizontalRuleEdit,
  imageEdit,
  linePrefixEdit,
  linkEdit,
  orderedListEdit,
  wrapEdit,
  type TextEdit,
} from "./markdownEdits";

export interface SourceEditorHandle {
  /** Scroll to a 0-based source line and highlight it. */
  scrollToLine(line: number): void;
  /** Select a character range [from,to) and scroll it into view (for find navigation). */
  selectRange(from: number, to: number): void;
  /** Set the heading level (1-6) of the cursor's line, or 0 to clear it back to a plain
   *  paragraph. Setting the line's current level again clears it (toggle). */
  setHeading(level: number): void;
  /** Toolbar formatting commands — see markdownEdits.ts for the toggle semantics. */
  toggleBold(): void;
  toggleItalic(): void;
  toggleStrikethrough(): void;
  toggleInlineCode(): void;
  toggleCodeBlock(): void;
  toggleBlockquote(): void;
  toggleBulletList(): void;
  toggleOrderedList(): void;
  toggleChecklist(): void;
  insertLink(): void;
  insertHorizontalRule(): void;
  /** Insert `![](relPath)` at the cursor (replacing any selection) — `relPath` is already the
   *  final saved location (from a paste or the toolbar's file picker), nothing left to fill in. */
  insertImage(relPath: string): void;
}

// The current line is shown by CodeMirror's own active-line highlight (basicSetup), which
// follows the cursor. scrollToLine moves the cursor, so clicking a line in EITHER pane lands
// that single highlight on the synced line — no separate "synced-line" decoration.

// Find highlighting inside the source pane (the "Editor" find scope). The field
// holds the query and re-derives match decorations on query change or doc edit.
const setFind = StateEffect.define<{ query: string; ci: boolean }>();
function findDeco(doc: { toString(): string }, query: string, ci: boolean): DecorationSet {
  if (!query) return Decoration.none;
  const text = doc.toString();
  const hay = ci ? text.toLowerCase() : text;
  const needle = ci ? query.toLowerCase() : query;
  const ranges = [];
  let i = hay.indexOf(needle);
  while (i !== -1) {
    ranges.push(Decoration.mark({ class: "cm-ap-find" }).range(i, i + needle.length));
    i = hay.indexOf(needle, i + needle.length);
  }
  return Decoration.set(ranges, true);
}
const findField = StateField.define<{ deco: DecorationSet; query: string; ci: boolean }>({
  create: () => ({ deco: Decoration.none, query: "", ci: false }),
  update(val, tr) {
    let { query, ci } = val;
    let changed = false;
    for (const e of tr.effects) if (e.is(setFind)) ({ query, ci } = e.value), (changed = true);
    if (changed || tr.docChanged) return { deco: findDeco(tr.state.doc, query, ci), query, ci };
    return val;
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v.deco),
});

export const SourceEditor = forwardRef<
  SourceEditorHandle,
  {
    value: string;
    editable: boolean;
    onChange: (v: string) => void;
    onCursorLine?: (line: number) => void;
    onFind?: () => void;
    find?: { query: string; ci: boolean } | null;
    binding?: EditorBinding | null;
    /** Comment threads anchored in the copied text — copy/cut embed them in the clipboard. */
    commentsForCopy?: (text: string) => Comment[];
    /** Cut text [from,to) that carried comments: the app removes the span + its threads. */
    onCutComments?: (text: string, from: number, to: number) => void;
    /** Paste a fragment carrying comments: the app re-IDs them, rewrites anchors, and splices. */
    onPasteComments?: (text: string, payload: ClipboardPayload, from: number, to: number) => void;
    /** A pasted image's raw bytes + MIME type: the app writes it to disk and resolves the
     *  relative link to embed, or null if it couldn't (host has nowhere to write it — e.g. a
     *  cloud doc). Absent ⇒ pasting an image is a no-op (no host to save it against). */
    onPasteImage?: (bytes: ArrayBuffer, mime: string) => Promise<string | null>;
  }
>(function SourceEditor({ value, editable, onChange, onCursorLine, onFind, find, binding, commentsForCopy, onCutComments, onPasteComments, onPasteImage }, ref): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editableComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorLineRef = useRef(onCursorLine);
  onCursorLineRef.current = onCursorLine;
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;
  const bindingRef = useRef(binding);
  bindingRef.current = binding;
  const commentsForCopyRef = useRef(commentsForCopy);
  commentsForCopyRef.current = commentsForCopy;
  const onCutCommentsRef = useRef(onCutComments);
  onCutCommentsRef.current = onCutComments;
  const onPasteCommentsRef = useRef(onPasteComments);
  onPasteCommentsRef.current = onPasteComments;
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;

  useImperativeHandle(ref, () => ({
    scrollToLine(line: number) {
      const v = view.current;
      if (!v) return;
      const n = Math.min(Math.max(1, line + 1), v.state.doc.lines);
      const pos = v.state.doc.line(n).from;
      // Move the cursor to the line so CodeMirror's native active-line highlight follows
      // (the single blue line), then scroll it into view. Don't focus — clicking the preview
      // must not steal focus (and find navigation keeps focus on the find bar).
      v.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    },
    selectRange(from: number, to: number) {
      const v = view.current;
      if (!v) return;
      const len = v.state.doc.length;
      const f = Math.max(0, Math.min(from, len));
      const t = Math.max(0, Math.min(to, len));
      // Select + scroll, but do NOT focus the editor — find navigation must leave
      // focus on the find bar so Enter keeps stepping through matches.
      v.dispatch({ selection: { anchor: f, head: t }, effects: EditorView.scrollIntoView(f, { y: "center" }) });
    },
    setHeading(level: number) {
      withSelection((text, from) => headingEdit(text, from, level));
    },
    toggleBold() {
      withSelection((text, from, to) => wrapEdit(text, from, to, "**"));
    },
    toggleItalic() {
      withSelection((text, from, to) => wrapEdit(text, from, to, "_"));
    },
    toggleStrikethrough() {
      withSelection((text, from, to) => wrapEdit(text, from, to, "~~"));
    },
    toggleInlineCode() {
      withSelection((text, from, to) => wrapEdit(text, from, to, "`"));
    },
    toggleCodeBlock() {
      withSelection(codeBlockEdit);
    },
    toggleBlockquote() {
      withSelection((text, from, to) => linePrefixEdit(text, from, to, "> "));
    },
    toggleBulletList() {
      withSelection((text, from, to) => linePrefixEdit(text, from, to, "- "));
    },
    toggleOrderedList() {
      withSelection(orderedListEdit);
    },
    toggleChecklist() {
      withSelection((text, from, to) => linePrefixEdit(text, from, to, "- [ ] ", /^-\s\[[ xX]\]\s/));
    },
    insertLink() {
      withSelection(linkEdit);
    },
    insertHorizontalRule() {
      withSelection(horizontalRuleEdit);
    },
    insertImage(relPath: string) {
      withSelection((text, from, to) => imageEdit(text, from, to, relPath));
    },
  }));

  /** Read the current selection, run `fn` over it, and dispatch the resulting edit. Toolbar
   *  commands go through here, so this is also the lock gate: `EditorView.editable` alone only
   *  stops the user from typing — it doesn't stop `v.dispatch()` — so without this check, a
   *  toolbar control that opened before the doc became read-only/agent-locked (e.g. the heading
   *  menu) could still mutate it after the fact. */
  function withSelection(fn: (text: string, from: number, to: number) => TextEdit) {
    const v = view.current;
    if (!v || !editable) return;
    const { from, to } = v.state.selection.main;
    const edit = fn(v.state.doc.toString(), from, to);
    v.dispatch(edit);
    v.focus();
  }

  useEffect(() => {
    if (!host.current) return;
    // Copy/cut a selection that carries span-comment anchors: embed the threads in the
    // clipboard's text/html. Returns false (native copy/cut) when there's nothing to carry,
    // or — for cut — when the app gave us no remover (so the span can't lose its threads).
    const handleCopyCut = (e: ClipboardEvent, v: EditorView, cut: boolean): boolean => {
      const sel = v.state.selection.main;
      if (sel.empty) return false;
      if (cut && !onCutCommentsRef.current) return false;
      const text = v.state.sliceDoc(sel.from, sel.to);
      const comments = commentsForCopyRef.current?.(text) ?? [];
      if (comments.length === 0) return false; // no anchored comments → native copy/cut
      e.preventDefault();
      e.clipboardData?.setData("text/plain", text);
      e.clipboardData?.setData("text/html", buildClipHtml(text, comments));
      if (cut) onCutCommentsRef.current!(text, sel.from, sel.to);
      return true;
    };
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        // With a plugin binding, it owns the content; otherwise the controlled value.
        doc: binding ? binding.getText() : value,
        extensions: [
          // ⌘F should open the app's find bar, not CodeMirror's own search panel. Also
          // overrides @codemirror/lang-markdown's own default Enter binding (still Prec.high,
          // so ours must outrank it): its default only exits a 2-item TIGHT list on the
          // SECOND Enter on an empty item — the first just loosens the list (CommonMark's
          // tight/loose distinction), inserting a blank line most people read as a stray
          // glitch rather than an intentional format change. `nonTightLists: false` skips
          // that step, so Enter on an empty list item always exits immediately.
          Prec.highest(
            keymap.of([
              {
                key: "Mod-f",
                run: () => {
                  onFindRef.current?.();
                  return true; // handled — suppress CodeMirror's search panel
                },
              },
              { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
            ]),
          ),
          basicSetup,
          markdown(),
          findField,
          editableComp.current.of(EditorView.editable.of(editable)),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.selectionSet && onCursorLineRef.current) {
              onCursorLineRef.current(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
            }
          }),
          // Copy/cut/paste that carries span-comment threads (see clipboard.ts). Each returns
          // false to fall through to CodeMirror's native handling whenever there's nothing
          // inplan-specific to do — so plain copy/paste, multi-cursor, etc. are untouched.
          EditorView.domEventHandlers({
            copy: (e, v) => handleCopyCut(e, v, false),
            cut: (e, v) => handleCopyCut(e, v, true),
            paste: (e, v) => {
              // An image on the clipboard (screenshot tool, browser "copy image", etc.) — write
              // it to disk and embed a Markdown image link, instead of falling through to
              // CodeMirror's native paste (which has no text/plain to insert for an image-only
              // clipboard anyway). Checked first: an image clipboard doesn't also carry the
              // inplan comment payload the branch below looks for.
              const imgFile = [...(e.clipboardData?.files ?? [])].find((f) => f.type.startsWith("image/"));
              if (imgFile && onPasteImageRef.current) {
                e.preventDefault();
                const pos = v.state.selection.main.from;
                const onPasteImage = onPasteImageRef.current;
                void imgFile.arrayBuffer().then(async (bytes) => {
                  const relPath = await onPasteImage(bytes, imgFile.type);
                  if (relPath) v.dispatch(imageEdit(v.state.doc.toString(), pos, pos, relPath));
                });
                return true;
              }
              if (!onPasteCommentsRef.current) return false;
              const html = e.clipboardData?.getData("text/html") ?? "";
              const payload = html ? readClipHtml(html) : null;
              if (!payload) return false; // foreign clipboard → native (plain-text) paste
              const text = e.clipboardData?.getData("text/plain") ?? "";
              const sel = v.state.selection.main;
              e.preventDefault();
              onPasteCommentsRef.current(text, payload, sel.from, sel.to);
              return true;
            },
          }),
          // Plugin-injected binding extensions (e.g. yCollab: live text sync, remote cursors, and —
          // wrapped at highest precedence by the binding via highestPrecKeymap — the collaborative
          // Yjs undo/redo keymap, so Mod-z beats basicSetup's native history).
          ...(binding ? binding.extensions : []),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || bindingRef.current) return; // with a plugin binding, it is the source of truth
    const current = v.state.doc.toString();
    if (value !== current) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editableComp.current.reconfigure(EditorView.editable.of(editable)) });
  }, [editable]);

  // Drive the in-editor find highlight from the app's find bar (Editor scope).
  useEffect(() => {
    view.current?.dispatch({ effects: setFind.of({ query: find?.query ?? "", ci: find?.ci ?? false }) });
  }, [find?.query, find?.ci]);

  return <div className="ap-source" ref={host} />;
});
