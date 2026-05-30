// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize, type ParsedDocument, type Question } from "@agent-planner/core";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
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
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.8;

/** The anchored label for a span comment, recovered from the body link. */
function anchoredText(body: string, id: string): string | null {
  const m = new RegExp(`\\[([^\\]]*)\\]\\(#${id}\\)`).exec(body);
  return m ? m[1]! : null;
}

const liveSelection = (): string => window.getSelection()?.toString().trim() ?? "";

interface OrderedThread {
  thread: Thread;
  group: 0 | 1; // 0 = document-level, 1 = text-anchored
  pos: number; // source index of the anchor (MAX for orphaned)
  orphaned: boolean;
}

export function App(): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [doc, setDoc] = useState<ParsedDocument>(EMPTY);
  const [cadence, setCadence] = useState<Cadence>("turn");
  const [acceptance, setAcceptance] = useState<Acceptance>("auto");
  const [panes, setPanes] = useState<1 | 2 | 3>(2);
  const [rightTab, setRightTab] = useState<"comments" | "source">("comments");
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [agentThinking, setAgentThinking] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [showResolvedOrphaned, setShowResolvedOrphaned] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [composer, setComposer] = useState<{ target: string | null } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);

  const docRef = useRef(doc);
  docRef.current = doc;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- persisted layout ---
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("ap-layout") ?? "{}");
      if (s.panes === 1 || s.panes === 2 || s.panes === 3) setPanes(s.panes);
      if (s.rightTab === "comments" || s.rightTab === "source") setRightTab(s.rightTab);
      if (typeof s.zoom === "number") setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.zoom)));
      if (typeof s.showResolvedOrphaned === "boolean") setShowResolvedOrphaned(s.showResolvedOrphaned);
      if (s.cadence === "turn" || s.cadence === "instant") setCadence(s.cadence);
      if (s.acceptance === "auto" || s.acceptance === "review") setAcceptance(s.acceptance);
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    localStorage.setItem("ap-layout", JSON.stringify({ panes, rightTab, zoom, showResolvedOrphaned, cadence, acceptance }));
  }, [panes, rightTab, zoom, showResolvedOrphaned, cadence, acceptance]);

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
    window.api.onAgentActive(() => {
      setAgentThinking(false);
      setStatus("agent took its turn — your move");
    });

    const onSel = () => setSelectionText(liveSelection());
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
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

  const onModeChange = useCallback((c: Cadence, a: Acceptance) => {
    setCadence(c);
    setAcceptance(a);
    void window.api.setMode(c, a);
  }, []);

  const onZoom = useCallback((dir: -1 | 0 | 1) => {
    setZoom((z) => (dir === 0 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + dir * 0.1).toFixed(2)))));
  }, []);

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
    (text: string, target: string | null, question?: Question) => {
      if (target) {
        const res = addSpanComment(docRef.current, target, { text, author: USER_AUTHOR, question });
        if (!res) {
          setStatus("could not anchor the selected text in the source");
          return;
        }
        apply(res.doc, { type: "comment_created", payload: { id: res.id } });
        setFocused(res.id);
      } else {
        const res = addDocComment(docRef.current, { text, author: USER_AUTHOR, question });
        apply(res.doc, { type: "comment_created", payload: { id: res.id, anchor: "doc" } });
        setFocused(res.id);
      }
    },
    [apply],
  );

  const openComposer = useCallback(() => {
    const sel = liveSelection();
    setComposer({ target: sel.length ? sel : null }); // target locked at open time
  }, []);

  const threads = useMemo(() => buildThreads(doc.comments), [doc.comments]);
  const ordered = useMemo<OrderedThread[]>(() => {
    const annotate = (thread: Thread): OrderedThread => {
      if (thread.root.anchor === "doc") return { thread, group: 0, pos: 0, orphaned: false };
      const idx = doc.body.indexOf(`](#${thread.root.id})`);
      return { thread, group: 1, pos: idx < 0 ? Number.MAX_SAFE_INTEGER : idx, orphaned: idx < 0 };
    };
    return threads.map(annotate).sort((a, b) => a.group - b.group || a.pos - b.pos);
  }, [threads, doc.body]);
  const visible = ordered.filter((o) => showResolvedOrphaned || (!o.thread.root.resolved && !o.orphaned));

  const resolvedIds = useMemo(() => new Set(doc.comments.filter((c) => c.resolved).map((c) => c.id)), [doc.comments]);
  const previewHtml = useMemo(
    () => renderMarkdown(doc.body, (id) => showResolvedOrphaned || !resolvedIds.has(id)),
    [doc.body, resolvedIds, showResolvedOrphaned],
  );

  if (!loaded) return <div className="ap-loading">Loading…</div>;

  const showSource = panes === 3 || (panes === 2 && rightTab === "source");
  const showComments = panes === 3 || panes === 1 || (panes === 2 && rightTab === "comments");

  return (
    <div className="ap-app">
      <TopBar
        cadence={cadence}
        acceptance={acceptance}
        panes={panes}
        zoom={zoom}
        hasSelection={selectionText.length > 0}
        onMode={onModeChange}
        onPanes={setPanes}
        onZoom={onZoom}
        onAddComment={openComposer}
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

      {composer && (
        <ComposerPopover
          target={composer.target}
          disabled={editingLocked}
          onSubmit={(text) => {
            addComment(text, composer.target);
            setComposer(null);
          }}
          onClose={() => setComposer(null)}
        />
      )}

      <div className="ap-main" style={{ zoom }}>
        <section className="ap-preview">
          <div
            className="ap-rendered"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
            onContextMenu={(e) => {
              if (editingLocked) return;
              const sel = liveSelection();
              if (sel.length) {
                e.preventDefault();
                setComposer({ target: sel });
              }
            }}
            onClick={(e) => {
              const a = (e.target as HTMLElement).closest("a");
              if (!a) return;
              e.preventDefault(); // links never navigate the editor window
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
            <SourceEditor value={doc.body} editable={!editingLocked} onChange={(body) => apply({ ...docRef.current, body })} />
          </section>
        )}

        {showComments && (
          <section className="ap-pane ap-rail">
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            <div className="ap-rail-head">
              <strong>Comments</strong>
              <label>
                <input type="checkbox" checked={showResolvedOrphaned} onChange={(e) => setShowResolvedOrphaned(e.target.checked)} /> resolved &amp; orphaned
              </label>
            </div>
            {visible.map((o, i) => (
              <Fragment key={o.thread.root.id}>
                {i > 0 && visible[i - 1]!.group === 0 && o.group === 1 && <div className="ap-splitter">Anchored comments</div>}
                <ThreadCard
                  thread={o.thread}
                  body={doc.body}
                  orphaned={o.orphaned}
                  focused={focused === o.thread.root.id}
                  disabled={editingLocked}
                  onFocus={() => setFocused(o.thread.root.id)}
                  onReply={(text) => apply(addReply(docRef.current, o.thread.root.id, text, USER_AUTHOR).doc, { type: "comment_created", payload: { parentId: o.thread.root.id } })}
                  onAnswer={(selected, text) => apply(addAnswer(docRef.current, o.thread.root.id, selected, text, USER_AUTHOR).doc, { type: "comment_answered", payload: { parentId: o.thread.root.id, selected } })}
                  onResolve={(r) => apply(setResolved(docRef.current, o.thread.root.id, r), { type: "comment_resolved", payload: { id: o.thread.root.id, resolved: r } })}
                  onEdit={(text) => apply(editCommentText(docRef.current, o.thread.root.id, text), { type: "comment_modified", payload: { id: o.thread.root.id } })}
                  onDelete={() => apply(deleteComment(docRef.current, o.thread.root.id), { type: "comment_deleted", payload: { id: o.thread.root.id } })}
                />
              </Fragment>
            ))}
            {visible.length === 0 && <div className="ap-empty">No comments. Select text and use “+ Add Comment”.</div>}
          </section>
        )}
      </div>

      <StatusBar cadence={cadence} status={status} dirty={dirty} agentThinking={agentThinking} />
    </div>
  );
}

function PaneIcon({ n }: { n: 1 | 2 | 3 }): JSX.Element {
  return (
    <span className="ap-pane-ic" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i} />
      ))}
    </span>
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
  zoom: number;
  hasSelection: boolean;
  onMode: (c: Cadence, a: Acceptance) => void;
  onPanes: (p: 1 | 2 | 3) => void;
  onZoom: (dir: -1 | 0 | 1) => void;
  onAddComment: () => void;
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
        {([1, 2, 3] as const).map((n) => (
          <button key={n} className={panes === n ? "active" : ""} title={`${n} pane${n > 1 ? "s" : ""}`} onClick={() => props.onPanes(n)}>
            <PaneIcon n={n} />
          </button>
        ))}
      </div>
      <div className="ap-seg" role="group" aria-label="zoom">
        <button title="Zoom out" onClick={() => props.onZoom(-1)}>
          −
        </button>
        <button title="Reset zoom" onClick={() => props.onZoom(0)}>
          {Math.round(props.zoom * 100)}%
        </button>
        <button title="Zoom in" onClick={() => props.onZoom(1)}>
          +
        </button>
      </div>
      <button onClick={props.onAddComment} disabled={props.locked}>
        {props.hasSelection ? "+ Add Comment" : "+ Add Doc Comment"}
      </button>
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

function ComposerPopover({
  target,
  disabled,
  onSubmit,
  onClose,
}: {
  target: string | null;
  disabled: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    ta.current?.focus();
  }, []);

  // Click outside an EMPTY composer dismisses it (keeps it if you've typed).
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !text.trim()) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [text, onClose]);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22)}px`; // cap at ~8 lines
  };

  const submit = () => {
    if (text.trim()) onSubmit(text.trim());
  };

  return (
    <div className="ap-composer ap-composer-float" ref={box}>
      <div className="ap-quote">{target ? `on “${target}”` : "document-level comment"}</div>
      <textarea
        ref={ta}
        className="ap-grow"
        placeholder="Add a comment…  (⌘/Ctrl+Enter to submit)"
        value={text}
        disabled={disabled}
        onChange={(e) => {
          setText(e.target.value);
          grow(e.target);
        }}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="ap-row">
        <button onClick={submit} disabled={disabled || !text.trim()}>
          Comment
        </button>
        <button className="ap-link" onClick={onClose}>
          cancel
        </button>
      </div>
    </div>
  );
}

function ThreadCard(props: {
  thread: Thread;
  body: string;
  orphaned: boolean;
  focused: boolean;
  disabled: boolean;
  onFocus: () => void;
  onReply: (text: string) => void;
  onAnswer: (selected: string[], text: string) => void;
  onResolve: (resolved: boolean) => void;
  onEdit: (text: string) => void;
  onDelete: () => void;
}): JSX.Element {
  const { thread, body, disabled, orphaned } = props;
  const root = thread.root;
  const quote = root.anchor === "doc" ? "· document" : orphaned ? "⚠ anchor removed (orphaned)" : anchoredText(body, root.id);
  const [replyText, setReplyText] = useState("");
  const [editing, setEditing] = useState(false);
  const [editText, setEditText] = useState(root.text);

  return (
    <article className={`ap-thread${props.focused ? " focused" : ""}${root.resolved ? " resolved" : ""}${orphaned ? " orphaned" : ""}`} onClick={props.onFocus}>
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
          <input type={question.multiSelect ? "checkbox" : "radio"} name={`q-${c.label}`} checked={selected.includes(c.label)} disabled={disabled} onChange={() => toggle(c.label)} />
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
