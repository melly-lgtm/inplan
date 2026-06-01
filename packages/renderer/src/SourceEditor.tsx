// SPDX-License-Identifier: AGPL-3.0-or-later

import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { yCollab } from "y-codemirror.next";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import type { CollabBinding } from "./api";

export interface SourceEditorHandle {
  /** Scroll to a 0-based source line and highlight it. */
  scrollToLine(line: number): void;
  /** Select a character range [from,to) and scroll it into view (for find navigation). */
  selectRange(from: number, to: number): void;
}

const setActiveLine = StateEffect.define<number | null>();

// Highlights the active (clicked / synced) line with the comment light-blue.
const activeLineField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    for (const e of tr.effects) {
      if (e.is(setActiveLine)) {
        if (e.value == null) return Decoration.none;
        const n = Math.min(Math.max(1, e.value + 1), tr.state.doc.lines);
        return Decoration.set([Decoration.line({ class: "ap-active-line" }).range(tr.state.doc.line(n).from)]);
      }
    }
    return deco.map(tr.changes);
  },
  provide: (f) => EditorView.decorations.from(f),
});

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
  { value: string; editable: boolean; onChange: (v: string) => void; onCursorLine?: (line: number) => void; onFind?: () => void; find?: { query: string; ci: boolean } | null; collab?: CollabBinding | null }
>(function SourceEditor({ value, editable, onChange, onCursorLine, onFind, find, collab }, ref): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editableComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorLineRef = useRef(onCursorLine);
  onCursorLineRef.current = onCursorLine;
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;
  const collabRef = useRef(collab);
  collabRef.current = collab;

  useImperativeHandle(ref, () => ({
    scrollToLine(line: number) {
      const v = view.current;
      if (!v) return;
      const n = Math.min(Math.max(1, line + 1), v.state.doc.lines);
      const pos = v.state.doc.line(n).from;
      v.dispatch({ effects: [setActiveLine.of(line), EditorView.scrollIntoView(pos, { y: "center" })] });
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
  }));

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        // In collab mode ***REMOVED*** owns the content; otherwise it's the controlled value.
        doc: collab ? collab.ytext.toString() : value,
        extensions: [
          // ⌘F should open the app's find bar, not CodeMirror's own search panel.
          Prec.highest(
            keymap.of([
              {
                key: "Mod-f",
                run: () => {
                  onFindRef.current?.();
                  return true; // handled — suppress CodeMirror's search panel
                },
              },
            ]),
          ),
          basicSetup,
          markdown(),
          activeLineField,
          findField,
          editableComp.current.of(EditorView.editable.of(editable)),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.selectionSet && onCursorLineRef.current) {
              onCursorLineRef.current(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
            }
          }),
          // Live collaboration: bind to the shared ***REMOVED*** + render remote cursors.
          ...(collab ? [yCollab(collab.ytext, collab.awareness)] : []),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v || collabRef.current) return; // in collab mode ***REMOVED*** is the source of truth
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
