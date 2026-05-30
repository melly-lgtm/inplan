// SPDX-License-Identifier: AGPL-3.0-or-later

import { markdown } from "@codemirror/lang-markdown";
import { Compartment, EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, keymap, type DecorationSet } from "@codemirror/view";
import { basicSetup } from "codemirror";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";

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

export const SourceEditor = forwardRef<
  SourceEditorHandle,
  { value: string; editable: boolean; onChange: (v: string) => void; onCursorLine?: (line: number) => void; onFind?: () => void }
>(function SourceEditor({ value, editable, onChange, onCursorLine, onFind }, ref): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const editableComp = useRef(new Compartment());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onCursorLineRef = useRef(onCursorLine);
  onCursorLineRef.current = onCursorLine;
  const onFindRef = useRef(onFind);
  onFindRef.current = onFind;

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
      v.dispatch({ selection: { anchor: f, head: t }, effects: EditorView.scrollIntoView(f, { y: "center" }) });
      v.focus();
    },
  }));

  useEffect(() => {
    if (!host.current) return;
    const v = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
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
          editableComp.current.of(EditorView.editable.of(editable)),
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
            if (u.selectionSet && onCursorLineRef.current) {
              onCursorLineRef.current(u.state.doc.lineAt(u.state.selection.main.head).number - 1);
            }
          }),
        ],
      }),
    });
    view.current = v;
    return () => v.destroy();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const current = v.state.doc.toString();
    if (value !== current) {
      v.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  useEffect(() => {
    view.current?.dispatch({ effects: editableComp.current.reconfigure(EditorView.editable.of(editable)) });
  }, [editable]);

  return <div className="ap-source" ref={host} />;
});
