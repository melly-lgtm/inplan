// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize, type Comment, type ParsedDocument, type Question } from "@agent-planner/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Acceptance, Cadence } from "../shared/api";
import {
  addAnswer,
  addDocComment,
  addReply,
  addSpanComment,
  buildThreads,
  deleteComment,
  editCommentText,
  setResolved,
  type Thread,
} from "./docOps";
import { renderMarkdown } from "./markdown";
import { SourceEditor } from "./SourceEditor";

const USER_AUTHOR = "You";
const EMPTY: ParsedDocument = { body: "", comments: [] };

/** The anchored label for a span comment, recovered from the body link. */
function anchoredText(body: string, id: string): string | null {
  const m = new RegExp(`\\[([^\\]]*)\\]\\(#${id}\\)`).exec(body);
  return m ? m[1]! : null;
}

export function App(): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [doc, setDoc] = useState<ParsedDocument>(EMPTY);
  const [cadence, setCadence] = useState<Cadence>("turn");
  const [acceptance, setAcceptance] = useState<Acceptance>("auto");
  const [panes, setPanes] = useState<1 | 2 | 3>(2);
  const [rightTab, setRightTab] = useState<"comments" | "source">("comments");
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [agentThinking, setAgentThinking] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [showResolved, setShowResolved] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const docRef = useRef(doc);
  docRef.current = doc;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- load + agent signals ---
  useEffect(() => {
    window.api
      .load()
      .then(({ content }) => {
        setDoc(parse(content));
        setLoaded(true);
      })
      .catch(() => setLoaded(true));

    window.api.onExternalChange(({ content }) => {
      setDoc(parse(content));
      setDirty(false);
      setAgentThinking(false);
      setStatus("agent updated the document");
    });
    window.api.onAgentDone(() => setAgentDone(true));
  }, []);

  const editingLocked = cadence === "turn" && agentThinking;

  // --- autosave ---
  useEffect(() => {
    if (!dirty || !loaded) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const delay = cadence === "instant" ? 5000 : 1500;
    autosaveTimer.current = setTimeout(() => {
      const content = serialize(docRef.current);
      if (cadence === "instant") {
        void window.api.save(content, { kind: "canonical", cadence });
        setDirty(false);
        setStatus("auto-saving…");
      } else {
        void window.api.save(content, { kind: "backup", cadence });
        setStatus("autosaved (backup)");
      }
    }, delay);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [doc, dirty, loaded, cadence]);

  // --- mutate helpers ---
  const apply = useCallback((next: ParsedDocument, action?: { type: string; payload?: unknown }) => {
    setDoc(next);
    setDirty(true);
    if (action) void window.api.logAction(action.type, action.payload);
  }, []);

  const onModeChange = useCallback(
    (c: Cadence, a: Acceptance) => {
      setCadence(c);
      setAcceptance(a);
      void window.api.setMode(c, a);
    },
    [],
  );

  const saveNow = useCallback(() => {
    const content = serialize(docRef.current);
    const kind = cadence === "instant" ? "canonical" : "backup";
    void window.api.save(content, { kind, cadence });
    if (kind === "canonical") setDirty(false);
    setStatus(kind === "canonical" ? "saved" : "checkpoint saved");
  }, [cadence]);

  const finishTurn = useCallback(() => {
    void window.api.save(serialize(docRef.current), { kind: "canonical", cadence: "turn" });
    setDirty(false);
    setAgentThinking(true);
    setStatus("turn finished — waiting for agent");
  }, []);

  const complete = useCallback(() => {
    void window.api.complete(serialize(docRef.current));
  }, []);

  // --- comment actions ---
  const addComment = useCallback(
    (text: string, question?: Question) => {
      if (pendingSelection) {
        const res = addSpanComment(docRef.current, pendingSelection, { text, author: USER_AUTHOR, question });
        if (!res) {
          setStatus("could not anchor: selected text not found uniquely in the source");
          return;
        }
        apply(res.doc, { type: "comment_created", payload: { id: res.id } });
        setFocused(res.id);
      } else {
        const res = addDocComment(docRef.current, { text, author: USER_AUTHOR, question });
        apply(res.doc, { type: "comment_created", payload: { id: res.id, anchor: "doc" } });
        setFocused(res.id);
      }
      setPendingSelection(null);
    },
    [apply, pendingSelection],
  );

  const onPreviewMouseUp = useCallback(() => {
    if (editingLocked) return;
    const sel = window.getSelection()?.toString().trim() ?? "";
    if (sel.length > 0) setPendingSelection(sel);
  }, [editingLocked]);

  const threads = useMemo(() => buildThreads(doc.comments), [doc.comments]);
  const visibleThreads = showResolved ? threads : threads.filter((t) => !t.root.resolved);

  if (!loaded) return <div className="ap-loading">Loading…</div>;

  const showSource = panes === 3 || (panes === 2 && rightTab === "source");
  const showComments = panes === 3 || panes === 1 || (panes === 2 && rightTab === "comments");

  return (
    <div className="ap-app">
      <TopBar
        cadence={cadence}
        acceptance={acceptance}
        panes={panes}
        onMode={onModeChange}
        onPanes={setPanes}
        dirty={dirty}
        onSave={saveNow}
        onFinishTurn={finishTurn}
        onComplete={complete}
        locked={editingLocked}
      />

      {agentDone && (
        <div className="ap-banner">
          The agent thinks the plan is ready. <button onClick={complete}>Complete &amp; quit</button>
          <button className="ap-link" onClick={() => setAgentDone(false)}>
            dismiss
          </button>
        </div>
      )}

      <div className="ap-main">
        <section className="ap-preview" onMouseUp={onPreviewMouseUp}>
          <div
            className="ap-rendered"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.body) }}
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest("a");
              if (!a) return;
              // Never let a link navigate the editor window.
              e.preventDefault();
              const cmt = a.getAttribute("data-cmt");
              if (cmt) {
                setFocused(cmt);
                return;
              }
              const href = a.getAttribute("href") ?? "";
              if (/^https?:/.test(href)) window.open(href, "_blank");
            }}
          />
        </section>

        {showSource && (
          <section className="ap-pane">
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            <SourceEditor
              value={doc.body}
              editable={!editingLocked}
              onChange={(body) => apply({ ...docRef.current, body })}
            />
          </section>
        )}

        {showComments && (
          <section className="ap-pane ap-rail">
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            <div className="ap-rail-head">
              <strong>Comments</strong>
              <label>
                <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} /> resolved
              </label>
            </div>
            <Composer
              pendingSelection={pendingSelection}
              disabled={editingLocked}
              onCancel={() => setPendingSelection(null)}
              onSubmit={addComment}
            />
            {visibleThreads.map((t) => (
              <ThreadCard
                key={t.root.id}
                thread={t}
                body={doc.body}
                focused={focused === t.root.id}
                disabled={editingLocked}
                onFocus={() => setFocused(t.root.id)}
                onReply={(text) => apply(addReply(docRef.current, t.root.id, text, USER_AUTHOR).doc, { type: "comment_created", payload: { parentId: t.root.id } })}
                onAnswer={(selected, text) => apply(addAnswer(docRef.current, t.root.id, selected, text, USER_AUTHOR).doc, { type: "comment_answered", payload: { parentId: t.root.id, selected } })}
                onResolve={(r) => apply(setResolved(docRef.current, t.root.id, r), { type: "comment_resolved", payload: { id: t.root.id, resolved: r } })}
                onEdit={(text) => apply(editCommentText(docRef.current, t.root.id, text), { type: "comment_modified", payload: { id: t.root.id } })}
                onDelete={() => apply(deleteComment(docRef.current, t.root.id), { type: "comment_deleted", payload: { id: t.root.id } })}
              />
            ))}
          </section>
        )}
      </div>

      <StatusBar cadence={cadence} status={status} dirty={dirty} agentThinking={agentThinking} />
    </div>
  );
}

function PaneTabs({ tab, onTab }: { tab: "comments" | "source"; onTab: (t: "comments" | "source") => void }): JSX.Element {
  return (
    <div className="ap-tabs">
      <button className={tab === "comments" ? "active" : ""} onClick={() => onTab("comments")}>
        Comments
      </button>
      <button className={tab === "source" ? "active" : ""} onClick={() => onTab("source")}>
        Source
      </button>
    </div>
  );
}

function TopBar(props: {
  cadence: Cadence;
  acceptance: Acceptance;
  panes: 1 | 2 | 3;
  onMode: (c: Cadence, a: Acceptance) => void;
  onPanes: (p: 1 | 2 | 3) => void;
  dirty: boolean;
  onSave: () => void;
  onFinishTurn: () => void;
  onComplete: () => void;
  locked: boolean;
}): JSX.Element {
  const { cadence, acceptance, panes, onMode } = props;
  return (
    <header className="ap-topbar">
      <div className="ap-seg" role="group" aria-label="cadence">
        <button className={cadence === "turn" ? "active" : ""} onClick={() => onMode("turn", acceptance)}>
          Turn
        </button>
        <button className={cadence === "instant" ? "active" : ""} onClick={() => onMode("instant", acceptance)}>
          Instant
        </button>
      </div>
      <div className="ap-seg" role="group" aria-label="acceptance">
        <button className={acceptance === "auto" ? "active" : ""} onClick={() => onMode(cadence, "auto")}>
          Auto-accept
        </button>
        <button className={acceptance === "review" ? "active" : ""} onClick={() => onMode(cadence, "review")}>
          Review
        </button>
      </div>
      <div className="ap-seg" role="group" aria-label="panes">
        {[1, 2, 3].map((n) => (
          <button key={n} className={panes === n ? "active" : ""} onClick={() => props.onPanes(n as 1 | 2 | 3)}>
            {n}
          </button>
        ))}
      </div>
      <div className="ap-spacer" />
      <button onClick={props.onSave}>Save{props.dirty ? " •" : ""}</button>
      {cadence === "turn" && (
        <button onClick={props.onFinishTurn} disabled={props.locked}>
          Finish turn
        </button>
      )}
      <button className="ap-primary" onClick={props.onComplete}>
        Complete &amp; quit
      </button>
    </header>
  );
}

function StatusBar({ cadence, status, dirty, agentThinking }: { cadence: Cadence; status: string; dirty: boolean; agentThinking: boolean }): JSX.Element {
  const [dots, setDots] = useState(".");
  useEffect(() => {
    if (!agentThinking) return;
    const t = setInterval(() => setDots((d) => (d.length >= 3 ? "." : d + " .")), 500);
    return () => clearInterval(t);
  }, [agentThinking]);
  return (
    <footer className="ap-statusbar">
      <span>{agentThinking ? `Agent is thinking ${dots}` : status || "ready"}</span>
      <span className="ap-spacer" />
      <span>{cadence} mode</span>
      {dirty && <span> · unsaved</span>}
    </footer>
  );
}

function Composer({
  pendingSelection,
  disabled,
  onCancel,
  onSubmit,
}: {
  pendingSelection: string | null;
  disabled: boolean;
  onCancel: () => void;
  onSubmit: (text: string, question?: Question) => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const submit = () => {
    if (!text.trim()) return;
    onSubmit(text.trim());
    setText("");
  };
  return (
    <div className="ap-composer">
      {pendingSelection ? (
        <div className="ap-quote">on “{pendingSelection}”</div>
      ) : (
        <div className="ap-quote ap-muted">document-level comment</div>
      )}
      <textarea
        placeholder="Add a comment…"
        value={text}
        disabled={disabled}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="ap-row">
        <button onClick={submit} disabled={disabled}>
          Comment
        </button>
        {pendingSelection && (
          <button className="ap-link" onClick={onCancel}>
            clear selection
          </button>
        )}
      </div>
    </div>
  );
}

function ThreadCard(props: {
  thread: Thread;
  body: string;
  focused: boolean;
  disabled: boolean;
  onFocus: () => void;
  onReply: (text: string) => void;
  onAnswer: (selected: string[], text: string) => void;
  onResolve: (resolved: boolean) => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const { thread, body, disabled } = props;
  const root = thread.root;
  const quote = root.anchor === "doc" ? "· document" : anchoredText(body, root.id);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(root.text);

  return (
    <article className={`ap-thread${props.focused ? " focused" : ""}${root.resolved ? " resolved" : ""}`} onClick={props.onFocus}>
      <div className="ap-thread-quote">{quote ?? "(anchor missing)"}</div>
      <div className="ap-meta">
        {root.author} · {root.date.slice(0, 16).replace("T", " ")}
      </div>
      {editing ? (
        <div className="ap-row">
          <textarea value={editText} onChange={(e) => setEditText(e.target.value)} />
          <button
            onClick={() => {
              props.onEdit(editText);
              setEditing(false);
            }}
          >
            Save
          </button>
        </div>
      ) : (
        <div className="ap-text">{root.text}</div>
      )}

      {root.question && <QuestionChips question={root.question} disabled={disabled} onAnswer={props.onAnswer} />}

      {thread.replies.map((r) => (
        <div className="ap-reply" key={r.id}>
          <div className="ap-meta">
            ↳ {r.author} · {r.date.slice(0, 16).replace("T", " ")}
          </div>
          {r.selected && r.selected.length > 0 && <div className="ap-selected">▶ {r.selected.join(", ")}</div>}
          {r.text && <div className="ap-text">{r.text}</div>}
        </div>
      ))}

      <div className="ap-row ap-reply-box">
        <input
          placeholder="Reply…"
          value={replyText}
          disabled={disabled}
          onChange={(e) => setReplyText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && replyText.trim()) {
              props.onReply(replyText.trim());
              setReplyText("");
            }
          }}
        />
      </div>
      <div className="ap-row ap-actions">
        <button className="ap-link" disabled={disabled} onClick={() => props.onResolve(!root.resolved)}>
          {root.resolved ? "Reopen" : "Resolve"}
        </button>
        <button className="ap-link" disabled={disabled} onClick={() => setEditing((v) => !v)}>
          Modify
        </button>
        <button className="ap-link ap-danger" disabled={disabled} onClick={props.onDelete}>
          Delete
        </button>
      </div>
    </article>
  );
}

function QuestionChips({ question, disabled, onAnswer }: { question: Question; disabled: boolean; onAnswer: (selected: string[], text: string) => void }): JSX.Element {
  const [selected, setSelected] = useState<string[]>([]);
  const [other, setOther] = useState("");
  const toggle = (label: string) => {
    if (question.multiSelect) {
      setSelected((s) => (s.includes(label) ? s.filter((x) => x !== label) : [...s, label]));
    } else {
      setSelected([label]);
    }
  };
  return (
    <div className="ap-question">
      {question.choices.map((c) => (
        <label key={c.label} className={`ap-chip${selected.includes(c.label) ? " on" : ""}`}>
          <input
            type={question.multiSelect ? "checkbox" : "radio"}
            name={`q-${c.label}`}
            checked={selected.includes(c.label)}
            disabled={disabled}
            onChange={() => toggle(c.label)}
          />
          {c.label}
          {c.description ? <span className="ap-muted"> — {c.description}</span> : null}
        </label>
      ))}
      <input className="ap-other" placeholder="Other…" value={other} disabled={disabled} onChange={(e) => setOther(e.target.value)} />
      <button
        disabled={disabled || (selected.length === 0 && !other.trim())}
        onClick={() => {
          onAnswer(selected, other.trim());
          setSelected([]);
          setOther("");
        }}
      >
        Answer
      </button>
    </div>
  );
}
