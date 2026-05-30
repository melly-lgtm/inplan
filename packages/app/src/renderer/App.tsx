// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize, type Comment, type ParsedDocument, type Question } from "@agent-planner/core";
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
import { SourceEditor, type SourceEditorHandle } from "./SourceEditor";
import { applySegments, isChange, lineSegments, wordDiff, type DiffSegment, type WordPart } from "./textdiff";

const USER_AUTHOR = "You";
const EMPTY: ParsedDocument = { body: "", comments: [] };
const ZOOM_MIN = 0.6;
const ZOOM_MAX = 1.8;

function anchoredText(body: string, id: string): string | null {
  const m = new RegExp(`\\[([^\\]]*)\\]\\(#${id}\\)`).exec(body);
  return m ? m[1]! : null;
}

/** 0-based source line of a comment's anchor link, or null. */
function anchorLine(body: string, id: string): number | null {
  const idx = body.indexOf(`](#${id})`);
  if (idx < 0) return null;
  return body.slice(0, idx).split("\n").length - 1;
}

const liveSelection = (): string => window.getSelection()?.toString().trim() ?? "";

interface OrderedThread {
  thread: Thread;
  group: 0 | 1;
  pos: number;
  orphaned: boolean;
}

interface Proposal {
  baseBody: string;
  next: ParsedDocument;
}

type FindMatch = { scope: "body"; from: number; to: number } | { scope: "comment"; id: string; from: number; to: number };

export function App(): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [doc, setDoc] = useState<ParsedDocument>(EMPTY);
  const [cadence, setCadence] = useState<Cadence>("turn");
  const [acceptance, setAcceptance] = useState<Acceptance>("auto");
  const [autoResolve, setAutoResolve] = useState(true); // agent auto-resolves threads after incorporating
  const [panes, setPanes] = useState<1 | 2 | 3>(2);
  const [rightTab, setRightTab] = useState<"comments" | "source">("comments");
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [agentThinking, setAgentThinking] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [reloadReady, setReloadReady] = useState(false); // agent signalled a new build is ready to load
  const [showResolvedOrphaned, setShowResolvedOrphaned] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [composer, setComposer] = useState<{ target: string | null; pos: { x: number; y: number } } | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [activePreviewLine, setActivePreviewLine] = useState<number | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false); // is the review panel visible (vs. parked behind a banner)
  const [findOpen, setFindOpen] = useState(false);
  const [findOpts, setFindOpts] = useState<{ query: string; ci: boolean; inBody: boolean; inComments: boolean }>({ query: "", ci: false, inBody: true, inComments: false });

  const docRef = useRef(doc);
  docRef.current = doc;
  const previewRef = useRef<HTMLElement>(null);
  const railRef = useRef<HTMLElement>(null);
  const editorRef = useRef<SourceEditorHandle>(null);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const history = useRef<ParsedDocument[]>([]); // undo stack of doc snapshots
  const future = useRef<ParsedDocument[]>([]); // redo stack
  const savedRef = useRef<string>(""); // last canonical-saved serialized content (for the dirty dot)
  const skipPreviewScroll = useRef(false); // set when the active line came from a click in the preview itself

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

  // autoResolve is a global, cross-session user setting (affects agent behavior),
  // loaded from ~/.agent-planner/settings.json on launch — not localStorage.
  useEffect(() => {
    void window.api.getSettings().then((s) => setAutoResolve(s.autoResolve));
  }, []);

  // --- load + agent signals ---
  useEffect(() => {
    const showProposal = (content: string) => {
      // The agent's version is parked in `.proposed.md`; review it against the
      // current (canonical) body. The working doc stays unchanged until Apply.
      setProposal({ baseBody: docRef.current.body, next: parse(content) });
      setReviewOpen(true);
      setAgentThinking(false);
      setStatus("agent proposed changes — review below");
    };

    window.api
      .load()
      .then(({ content }) => {
        const d = parse(content);
        setDoc(d);
        savedRef.current = serialize(d);
        setLoaded(true);
        // Durable re-show: if a proposal was parked (e.g. the app was closed
        // mid-review), surface it again rather than silently accepting it.
        void window.api.getProposal().then((parked) => parked != null && showProposal(parked));
      })
      .catch(() => setLoaded(true));

    // Auto-accept (and review-mode comment-only changes) arrive as a file rewrite.
    window.api.onExternalChange(({ content }) => {
      const next = parse(content);
      setAgentThinking(false);
      setDoc(next);
      savedRef.current = serialize(next);
      setDirty(false);
      setStatus("agent updated the document");
    });
    // Review-mode body changes arrive parked, as a proposal to accept/reject.
    window.api.onProposal(({ content }) => showProposal(content));
    window.api.onAgentDone(() => setAgentDone(true));
    window.api.onReload(() => setReloadReady(true));
    window.api.onAgentActive(() => {
      setAgentThinking(false);
      setStatus("agent took its turn — your move");
    });

    const onSel = () => setSelectionText(liveSelection());
    document.addEventListener("selectionchange", onSel);
    return () => document.removeEventListener("selectionchange", onSel);
  }, []);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) {
      setStatus("nothing to undo");
      return;
    }
    future.current.push(docRef.current);
    setDoc(prev);
    setDirty(serialize(prev) !== savedRef.current);
    setStatus("undid last change");
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) {
      setStatus("nothing to redo");
      return;
    }
    history.current.push(docRef.current);
    setDoc(next);
    setDirty(serialize(next) !== savedRef.current);
    setStatus("redid change");
  }, []);

  // --- keyboard ergonomics ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        // While the source editor is focused, let CodeMirror handle typing undo.
        if ((document.activeElement as HTMLElement | null)?.closest(".ap-source")) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if ((e.metaKey || e.ctrlKey) && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        setFindOpen((v) => !v);
      } else if (e.key === "Escape") {
        if (composer) setComposer(null);
        else if (findOpen) setFindOpen(false);
        else if (proposal && reviewOpen) setReviewOpen(false);
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [composer, findOpen, proposal, reviewOpen, undo, redo]);

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
        savedRef.current = content;
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

  // Keep main informed of unsaved state so window-close can prompt Save/Don't Save.
  useEffect(() => {
    if (loaded) void window.api.reportState(dirty, serialize(docRef.current));
  }, [dirty, doc, loaded]);

  // --- preview current-line highlight + scroll ---
  useEffect(() => {
    const root = previewRef.current;
    if (!root) return;
    root.querySelectorAll(".ap-active-line").forEach((el) => el.classList.remove("ap-active-line"));
    if (activePreviewLine == null) return;
    let best: Element | null = null;
    let bestLine = -1;
    // Among blocks at or before the active line, pick the closest one. On a tie
    // (a container and its first child share a source line — `<ul>`/`<li>`,
    // `<blockquote>`/`<p>`), `>=` lets the later DOM node win, i.e. the more
    // specific child, so we highlight just that item rather than the whole list.
    root.querySelectorAll("[data-line]").forEach((el) => {
      const l = Number(el.getAttribute("data-line") ?? -1);
      if (l <= activePreviewLine && l >= bestLine) {
        bestLine = l;
        best = el;
      }
    });
    if (best) {
      (best as Element).classList.add("ap-active-line");
      // Don't scroll the preview when the click originated here — only re-center
      // when the active line was driven from another pane (the source editor).
      if (!skipPreviewScroll.current) (best as Element).scrollIntoView({ block: "center" });
    }
    skipPreviewScroll.current = false;
  }, [activePreviewLine, doc.body]);

  // The comment anchored on the active line (if any) — highlighted in the rail.
  const syncedCommentId = useMemo(() => {
    if (activePreviewLine == null) return null;
    for (const c of doc.comments) {
      if (c.parentId || c.anchor === "doc") continue;
      if (anchorLine(doc.body, c.id) === activePreviewLine) return c.id;
    }
    return null;
  }, [activePreviewLine, doc.body, doc.comments]);
  useEffect(() => {
    if (syncedCommentId) document.querySelector(`[data-cmt-card="${syncedCommentId}"]`)?.scrollIntoView({ block: "nearest" });
  }, [syncedCommentId]);

  // --- mutate helpers ---
  const apply = useCallback((next: ParsedDocument, action?: { type: string; payload?: unknown }) => {
    history.current.push(docRef.current); // snapshot for undo
    if (history.current.length > 200) history.current.shift();
    future.current = [];
    setDoc(next);
    setDirty(serialize(next) !== savedRef.current);
    if (action) void window.api.logAction(action.type, action.payload);
  }, []);

  const onModeChange = useCallback((c: Cadence, a: Acceptance) => {
    setCadence(c);
    setAcceptance(a);
    void window.api.setMode(c, a);
  }, []);

  // Auto-resolve is a global directive to the agent: persist it to the settings
  // file and log the change (main does both) so the agent wakes and can honor it.
  const onAutoResolve = useCallback((v: boolean) => {
    setAutoResolve(v);
    void window.api.setSettings({ autoResolve: v });
  }, []);

  const onZoom = useCallback((dir: -1 | 0 | 1) => {
    setZoom((z) => (dir === 0 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + dir * 0.1).toFixed(2)))));
  }, []);

  const saveNow = useCallback(() => {
    const content = serialize(docRef.current);
    const kind = cadence === "instant" ? "canonical" : "backup";
    void window.api.save(content, { kind, cadence });
    if (kind === "canonical") {
      savedRef.current = content;
      setDirty(false);
    }
    setStatus(kind === "canonical" ? "saved" : "checkpoint saved");
  }, [cadence]);

  const finishTurn = useCallback(() => {
    const content = serialize(docRef.current);
    void window.api.save(content, { kind: "canonical", cadence: "turn" });
    savedRef.current = content;
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

  const reportFind = useCallback((o: { query: string; ci: boolean; inBody: boolean; inComments: boolean }) => setFindOpts(o), []);

  const openComposer = useCallback(() => {
    const sel = window.getSelection();
    const txt = sel?.toString().trim() ?? "";
    if (txt && sel && sel.rangeCount > 0) {
      const r = sel.getRangeAt(0).getBoundingClientRect();
      setComposer({ target: txt, pos: { x: Math.max(8, Math.min(r.left, window.innerWidth - 360)), y: Math.max(48, Math.min(r.bottom + 6, window.innerHeight - 220)) } });
    } else {
      previewRef.current?.scrollTo({ top: 0 });
      setComposer({ target: null, pos: { x: 24, y: 56 } });
    }
  }, []);

  // --- cross-pane sync ---
  const syncToLine = useCallback((line: number) => {
    skipPreviewScroll.current = true; // the user clicked in the preview; don't re-scroll it
    setActivePreviewLine(line);
    editorRef.current?.scrollToLine(line);
  }, []);

  const focusComment = useCallback(
    (id: string, fromPreview = false) => {
      setFocused(id);
      const line = anchorLine(docRef.current.body, id);
      if (line != null) editorRef.current?.scrollToLine(line);
      // Re-center the anchor in the preview only when focus came from another
      // pane (the rail). If the user clicked the anchor in the preview itself,
      // don't yank the pane they just clicked.
      if (!fromPreview) previewRef.current?.querySelector(`[data-cmt="${id}"]`)?.scrollIntoView({ block: "center" });
    },
    [],
  );

  // Jump to a find match: body matches select in the source editor (revealing it)
  // and scroll the preview; comment matches focus the comment thread.
  const navigateMatch = useCallback(
    (m: FindMatch) => {
      if (m.scope === "body") {
        setRightTab((t) => (panes === 2 && t !== "source" ? "source" : t));
        editorRef.current?.selectRange(m.from, m.to);
        setActivePreviewLine(docRef.current.body.slice(0, m.from).split("\n").length - 1);
      } else {
        focusComment(m.id);
      }
    },
    [panes, focusComment],
  );

  // --- review apply ---
  const applyProposal = useCallback(
    (segs: DiffSegment[], accepted: boolean[]) => {
      if (!proposal) return;
      const body = applySegments(segs, accepted);
      const finalDoc: ParsedDocument = { body, comments: proposal.next.comments };
      setDoc(finalDoc);
      setProposal(null);
      setReviewOpen(false);
      const serialized = serialize(finalDoc);
      savedRef.current = serialized;
      setDirty(false);
      const acceptedCount = accepted.filter(Boolean).length;
      // Decision made → persist canonical and discard the parked proposal.
      void window.api.save(serialized, { kind: "canonical", cadence });
      void window.api.clearProposal();
      void window.api.logAction(acceptedCount === accepted.length ? "revision_accepted_all" : acceptedCount === 0 ? "revision_rejected_all" : "revision_hunk_accepted", { accepted: acceptedCount, total: accepted.length });
      setStatus(`applied agent revision (${acceptedCount}/${accepted.length} hunks)`);
    },
    [proposal, cadence],
  );

  // --- inline review state (shared by the preview + source panes and the bar) ---
  // The diff hunks and per-hunk accept flags live here, so both panes render the
  // same review and the preview alone is a complete review surface in 1-pane mode.
  const reviewSegs = useMemo(() => (proposal ? lineSegments(proposal.baseBody, proposal.next.body) : []), [proposal]);
  const changeCount = useMemo(() => reviewSegs.filter(isChange).length, [reviewSegs]);
  const [accepted, setAccepted] = useState<boolean[]>([]);
  useEffect(() => setAccepted(new Array(changeCount).fill(true)), [changeCount, proposal]);
  const toggleHunk = useCallback((idx: number, val: boolean) => setAccepted((a) => a.map((v, k) => (k === idx ? val : v))), []);
  const applyReview = useCallback(() => applyProposal(reviewSegs, accepted), [applyProposal, reviewSegs, accepted]);

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

  // Highlight find matches via the CSS Custom Highlight API (non-destructive
  // Ranges — no DOM mutation, so anchors stay intact). Preview when the body
  // scope is on; comment text in the rail when the comments scope is on.
  useEffect(() => {
    const cssApi = CSS as unknown as { highlights?: Map<string, unknown> };
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!cssApi.highlights || !HighlightCtor) return;
    cssApi.highlights.delete("ap-find");
    if (!findOpen || !findOpts.query) return;
    const needle = findOpts.ci ? findOpts.query.toLowerCase() : findOpts.query;
    const ranges: Range[] = [];
    const collect = (root: Node) => {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node: Node | null;
      while ((node = walker.nextNode())) {
        const text = node.nodeValue ?? "";
        const hay = findOpts.ci ? text.toLowerCase() : text;
        let i = hay.indexOf(needle);
        while (i !== -1) {
          const r = document.createRange();
          r.setStart(node, i);
          r.setEnd(node, i + needle.length);
          ranges.push(r);
          i = hay.indexOf(needle, i + needle.length);
        }
      }
    };
    if (findOpts.inBody && previewRef.current) collect(previewRef.current);
    if (findOpts.inComments && railRef.current) railRef.current.querySelectorAll(".ap-text").forEach((el) => collect(el));
    if (ranges.length) cssApi.highlights.set("ap-find", new HighlightCtor(...ranges));
  }, [findOpts, findOpen, previewHtml, doc.comments]);

  if (!loaded) return <div className="ap-loading">Loading…</div>;

  // 1 pane = preview only; 2 panes = preview + one of {source, comments} (tabbed);
  // 3 panes = preview + source + comments.
  const showSource = panes === 3 || (panes === 2 && rightTab === "source");
  const showComments = panes === 3 || (panes === 2 && rightTab === "comments");

  return (
    <div className="ap-app">
      <TopBar
        cadence={cadence}
        acceptance={acceptance}
        autoResolve={autoResolve}
        panes={panes}
        zoom={zoom}
        hasSelection={selectionText.length > 0}
        onMode={onModeChange}
        onAutoResolve={onAutoResolve}
        onPanes={setPanes}
        onZoom={onZoom}
        onAddComment={openComposer}
        onToggleFind={() => setFindOpen((v) => !v)}
        dirty={dirty}
        onSave={saveNow}
        onFinishTurn={finishTurn}
        onComplete={complete}
        locked={editingLocked}
      />

      {findOpen && (
        <FindReplaceBar
          doc={doc}
          onApply={apply}
          onClose={() => setFindOpen(false)}
          onNavigate={navigateMatch}
          onQuery={reportFind}
        />
      )}

      {agentDone && (
        <div className="ap-banner">
          The agent thinks the plan is ready. <button onClick={complete}>Complete &amp; quit</button>
          <button className="ap-link" onClick={() => setAgentDone(false)}>
            dismiss
          </button>
        </div>
      )}

      {reloadReady && (
        <div className="ap-banner ap-banner-reload">
          🔄 A new build is ready. <strong>Close this window (⌘W)</strong> to reload it — your turn edits will prompt to save first.
        </div>
      )}

      {proposal && !reviewOpen && (
        <div className="ap-banner">
          The agent proposed changes awaiting your review.{" "}
          <button onClick={() => setReviewOpen(true)}>Review</button>
        </div>
      )}

      {proposal && reviewOpen && (
        <div className="ap-review-bar">
          <strong>Agent proposed changes</strong> — {changeCount} change{changeCount === 1 ? "" : "s"} shown inline below
          <span className="ap-spacer" />
          <button onClick={() => setAccepted(new Array(changeCount).fill(true))}>Accept all</button>
          <button onClick={() => setAccepted(new Array(changeCount).fill(false))}>Reject all</button>
          <button className="ap-primary" onClick={applyReview}>
            Apply
          </button>
          <button className="ap-link" onClick={() => setReviewOpen(false)}>
            later
          </button>
        </div>
      )}

      {composer && (
        <ComposerPopover
          target={composer.target}
          pos={composer.pos}
          disabled={editingLocked}
          onSubmit={(text) => {
            addComment(text, composer.target);
            setComposer(null);
          }}
          onClose={() => setComposer(null)}
        />
      )}

      <div className="ap-main" style={{ zoom }}>
        <section className="ap-preview" ref={previewRef}>
          {proposal && reviewOpen ? (
            <DiffPreview segs={reviewSegs} accepted={accepted} onToggle={toggleHunk} />
          ) : (
          <div
            className="ap-rendered"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
            onContextMenu={(e) => {
              if (editingLocked) return;
              const sel = liveSelection();
              if (sel.length) {
                e.preventDefault();
                setComposer({ target: sel, pos: { x: Math.max(8, Math.min(e.clientX, window.innerWidth - 360)), y: e.clientY + 6 } });
              }
            }}
            onClick={(e) => {
              const target = e.target as HTMLElement;
              const a = target.closest("a");
              if (a) {
                e.preventDefault();
                const cmt = a.getAttribute("data-cmt");
                if (cmt) {
                  focusComment(cmt, true); // clicked in the preview — don't re-scroll the preview
                  return;
                }
                const href = a.getAttribute("href") ?? "";
                if (/^https?:/.test(href)) window.open(href, "_blank");
                return;
              }
              const block = target.closest("[data-line]");
              if (block) syncToLine(Number(block.getAttribute("data-line")));
            }}
          />
          )}
        </section>

        {showSource && (
          <section className="ap-pane">
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            {proposal && reviewOpen ? (
              <DiffSource segs={reviewSegs} accepted={accepted} onToggle={toggleHunk} />
            ) : (
              <SourceEditor
                ref={editorRef}
                value={doc.body}
                editable={!editingLocked}
                onChange={(body) => {
                  // Typing has its own (CodeMirror) undo; don't push app-level history per keystroke.
                  const nd = { ...docRef.current, body };
                  setDoc(nd);
                  setDirty(serialize(nd) !== savedRef.current);
                }}
                onCursorLine={(line) => setActivePreviewLine(line)}
              />
            )}
          </section>
        )}

        {showComments && (
          <section className="ap-pane ap-rail" ref={railRef}>
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            <div className="ap-rail-head">
              <strong>Comments</strong>
              <label>
                <input type="checkbox" checked={showResolvedOrphaned} onChange={(e) => setShowResolvedOrphaned(e.target.checked)} /> resolved &amp; orphaned
              </label>
            </div>
            {visible.map((o, i) => (
              <Fragment key={o.thread.root.id}>
                {(i === 0 || visible[i - 1]!.group !== o.group) && (
                  <div className="ap-section-title">{o.group === 0 ? "Document" : "Anchored"}</div>
                )}
                <ThreadCard
                  thread={o.thread}
                  body={doc.body}
                  orphaned={o.orphaned}
                  focused={focused === o.thread.root.id}
                  synced={syncedCommentId === o.thread.root.id}
                  disabled={editingLocked}
                  onFocus={() => focusComment(o.thread.root.id)}
                  onReply={(text) => apply(addReply(docRef.current, o.thread.root.id, text, USER_AUTHOR).doc, { type: "comment_created", payload: { parentId: o.thread.root.id } })}
                  onAnswer={(selected, text) => apply(addAnswer(docRef.current, o.thread.root.id, selected, text, USER_AUTHOR).doc, { type: "comment_answered", payload: { parentId: o.thread.root.id, selected } })}
                  onResolve={(r) => apply(setResolved(docRef.current, o.thread.root.id, r), { type: "comment_resolved", payload: { id: o.thread.root.id, resolved: r } })}
                  onEdit={(id, text) => apply(editCommentText(docRef.current, id, text), { type: "comment_modified", payload: { id } })}
                  onDelete={(id) => apply(deleteComment(docRef.current, id), { type: "comment_deleted", payload: { id } })}
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

function SettingsMenu({
  acceptance,
  autoResolve,
  onAcceptance,
  onAutoResolve,
}: {
  acceptance: Acceptance;
  autoResolve: boolean;
  onAcceptance: (a: Acceptance) => void;
  onAutoResolve: (v: boolean) => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, []);
  return (
    <div className="ap-settings" ref={ref}>
      <button title="Settings" onClick={() => setOpen((v) => !v)}>
        ⚙
      </button>
      {open && (
        <div className="ap-settings-menu">
          <div className="ap-settings-row">
            <span>Agent changes</span>
            <div className="ap-seg">
              <button className={acceptance === "auto" ? "active" : ""} onClick={() => onAcceptance("auto")}>
                Auto-accept
              </button>
              <button className={acceptance === "review" ? "active" : ""} onClick={() => onAcceptance("review")}>
                Review
              </button>
            </div>
          </div>
          <label className="ap-settings-row">
            <span>Agent auto-resolves a thread after incorporating it</span>
            <input type="checkbox" checked={autoResolve} onChange={(e) => onAutoResolve(e.target.checked)} />
          </label>
          <div className="ap-settings-hint">When off, the agent replies that the thread can be resolved and leaves it for you.</div>
        </div>
      )}
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
  autoResolve: boolean;
  panes: 1 | 2 | 3;
  zoom: number;
  hasSelection: boolean;
  onMode: (c: Cadence, a: Acceptance) => void;
  onAutoResolve: (v: boolean) => void;
  onPanes: (p: 1 | 2 | 3) => void;
  onZoom: (dir: -1 | 0 | 1) => void;
  onAddComment: () => void;
  onToggleFind: () => void;
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
      <SettingsMenu acceptance={acceptance} autoResolve={props.autoResolve} onAcceptance={(a) => onMode(cadence, a)} onAutoResolve={props.onAutoResolve} />
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
      <button onClick={props.onToggleFind} title="Find &amp; replace">
        Find
      </button>
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

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function FindReplaceBar({
  doc,
  onApply,
  onClose,
  onNavigate,
  onQuery,
}: {
  doc: ParsedDocument;
  onApply: (next: ParsedDocument, action?: { type: string; payload?: unknown }) => void;
  onClose: () => void;
  onNavigate: (m: FindMatch) => void;
  onQuery: (opts: { query: string; ci: boolean; inBody: boolean; inComments: boolean }) => void;
}): JSX.Element {
  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [replaceMode, setReplaceMode] = useState(false);
  const [inBody, setInBody] = useState(true); // the document body (preview + editor)
  const [inComments, setInComments] = useState(false);
  const [ci, setCi] = useState(false);
  const [idx, setIdx] = useState(0);
  const navAfterReplace = useRef(false);

  // Report the query + scope up so the preview/rail can highlight matches; clear on unmount.
  useEffect(() => {
    onQuery({ query: find, ci, inBody, inComments });
  }, [find, ci, inBody, inComments, onQuery]);
  useEffect(() => () => onQuery({ query: "", ci: false, inBody: true, inComments: false }), [onQuery]);

  const matches = useMemo<FindMatch[]>(() => {
    if (!find) return [];
    const flags = "g" + (ci ? "i" : "");
    const out: FindMatch[] = [];
    const scan = (text: string, make: (from: number, to: number) => FindMatch) => {
      const re = new RegExp(escapeRegExp(find), flags);
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out.push(make(m.index, m.index + m[0].length));
        if (m[0].length === 0) re.lastIndex++;
      }
    };
    if (inBody) scan(doc.body, (from, to) => ({ scope: "body", from, to }));
    if (inComments) for (const c of doc.comments) scan(c.text, (from, to) => ({ scope: "comment", id: c.id, from, to }));
    return out;
  }, [find, doc, inBody, inComments, ci]);

  const n = matches.length;
  useEffect(() => {
    if (idx >= n) setIdx(n ? n - 1 : 0);
  }, [n, idx]);
  // After a single replace, re-render brings fresh matches — jump to the next one.
  useEffect(() => {
    if (navAfterReplace.current && n) onNavigate(matches[Math.min(idx, n - 1)]!);
    navAfterReplace.current = false;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matches]);

  const go = (to: number) => {
    if (!n) return;
    const i = ((to % n) + n) % n;
    setIdx(i);
    onNavigate(matches[i]!);
  };

  const replaceOne = (m: FindMatch): ParsedDocument =>
    m.scope === "body"
      ? { ...doc, body: doc.body.slice(0, m.from) + replace + doc.body.slice(m.to) }
      : { ...doc, comments: doc.comments.map((c) => (c.id === m.id ? { ...c, text: c.text.slice(0, m.from) + replace + c.text.slice(m.to) } : c)) };

  const replaceCurrent = (dir: 1 | -1) => {
    if (!n) return;
    const m = matches[idx]!;
    navAfterReplace.current = true;
    if (dir === -1) setIdx(Math.max(0, idx - 1));
    onApply(replaceOne(m), { type: "document_edited", payload: { findReplace: "one" } });
  };

  const replaceAll = () => {
    if (!find) return;
    const flags = "g" + (ci ? "i" : "");
    const body = inBody ? doc.body.replace(new RegExp(escapeRegExp(find), flags), replace) : doc.body;
    const comments = inComments ? doc.comments.map((c) => ({ ...c, text: c.text.replace(new RegExp(escapeRegExp(find), flags), replace) })) : doc.comments;
    onApply({ body, comments }, { type: "document_edited", payload: { findReplace: "all" } });
  };

  return (
    <div className="ap-find">
      <label className="ap-find-mode" title="toggle replace">
        <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> Replace
      </label>
      <input
        placeholder="Find…"
        value={find}
        onChange={(e) => {
          setFind(e.target.value);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") go(e.shiftKey ? idx - 1 : idx + 1);
        }}
        autoFocus
      />
      {replaceMode && <input placeholder="Replace…" value={replace} onChange={(e) => setReplace(e.target.value)} />}
      <span className="ap-find-scope">
        <label>
          <input type="checkbox" checked={inBody} onChange={(e) => setInBody(e.target.checked)} /> body
        </label>
        <label>
          <input type="checkbox" checked={inComments} onChange={(e) => setInComments(e.target.checked)} /> comments
        </label>
        <label title="case-insensitive">
          <input type="checkbox" checked={ci} onChange={(e) => setCi(e.target.checked)} /> Aa
        </label>
      </span>
      <span className="ap-muted">{n ? `${Math.min(idx + 1, n)}/${n}` : "0/0"}</span>
      {replaceMode ? (
        <>
          <button onClick={() => replaceCurrent(-1)} disabled={!n}>
            Replace Prev
          </button>
          <button onClick={() => replaceCurrent(1)} disabled={!n}>
            Replace Next
          </button>
          <button onClick={replaceAll} disabled={!n}>
            Replace All
          </button>
        </>
      ) : (
        <>
          <button onClick={() => go(idx - 1)} disabled={!n}>
            Find Prev
          </button>
          <button onClick={() => go(idx + 1)} disabled={!n}>
            Find Next
          </button>
        </>
      )}
      <button className="ap-link" onClick={onClose}>
        close
      </button>
    </div>
  );
}

/** Inline diff rendered in the PREVIEW pane: changed blocks shown in place as
 *  rendered Markdown, with a per-hunk accept/reject toggle. This is the complete
 *  review surface in 1-pane mode (where the source pane isn't visible). */
function DiffPreview({ segs, accepted, onToggle }: { segs: DiffSegment[]; accepted: boolean[]; onToggle: (i: number, v: boolean) => void }): JSX.Element {
  let ci = -1;
  return (
    <div className="ap-rendered ap-diffview">
      {segs.map((s, i) => {
        if (s.same) {
          return <div key={i} className="ap-ctx" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.same.join("\n"), () => false) }} />;
        }
        ci++;
        const idx = ci;
        const on = accepted[idx] ?? true;
        return (
          <div key={i} className={`ap-ihunk${on ? " accepted" : " rejected"}`}>
            <div className="ap-ihunk-bar">
              <span>change {idx + 1}</span>
              <span className="ap-spacer" />
              <button className={on ? "on" : ""} onClick={() => onToggle(idx, true)}>
                accept
              </button>
              <button className={!on ? "on" : ""} onClick={() => onToggle(idx, false)}>
                reject
              </button>
            </div>
            {s.removed && s.removed.length > 0 && (
              <div className="ap-ihunk-del" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.removed.join("\n"), () => false) }} />
            )}
            {s.added && s.added.length > 0 && (
              <div className="ap-ihunk-add" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.added.join("\n"), () => false) }} />
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Inline diff rendered in the SOURCE pane: a monospaced unified diff with the
 *  same per-hunk accept/reject toggles, bound to the same accept state. */
function DiffSource({ segs, accepted, onToggle }: { segs: DiffSegment[]; accepted: boolean[]; onToggle: (i: number, v: boolean) => void }): JSX.Element {
  let ci = -1;
  return (
    <div className="ap-source ap-diffsource">
      {segs.map((s, i) => {
        if (s.same) {
          return (
            <pre key={i} className="ap-diff-same">
              {s.same.slice(Math.max(0, s.same.length - 3)).join("\n")}
            </pre>
          );
        }
        ci++;
        const idx = ci;
        const on = accepted[idx] ?? true;
        return (
          <div key={i} className={`ap-hunk${on ? " accepted" : " rejected"}`}>
            <label className="ap-hunk-toggle">
              <input type="checkbox" checked={on} onChange={(e) => onToggle(idx, e.target.checked)} /> accept change {idx + 1}
            </label>
            <HunkLines removed={s.removed ?? []} added={s.added ?? []} />
          </div>
        );
      })}
    </div>
  );
}

function WordLine({ wd, side }: { wd: WordPart[]; side: "del" | "add" }): JSX.Element {
  const skip = side === "del" ? "add" : "del";
  const mark = side === "del" ? "del" : "add";
  return (
    <pre className={side === "del" ? "ap-diff-del" : "ap-diff-add"}>
      {side === "del" ? "− " : "+ "}
      {wd
        .filter((p) => p.kind !== skip)
        .map((p, i) => (p.kind === mark ? <span key={i} className="w">{p.text}</span> : <span key={i}>{p.text}</span>))}
    </pre>
  );
}

function HunkLines({ removed, added }: { removed: string[]; added: string[] }): JSX.Element {
  const pairs = Math.min(removed.length, added.length);
  const rows: JSX.Element[] = [];
  for (let k = 0; k < pairs; k++) {
    const wd = wordDiff(removed[k]!, added[k]!);
    rows.push(<WordLine key={`r${k}`} wd={wd} side="del" />);
    rows.push(<WordLine key={`a${k}`} wd={wd} side="add" />);
  }
  for (let k = pairs; k < removed.length; k++) {
    rows.push(
      <pre key={`re${k}`} className="ap-diff-del">
        − {removed[k]}
      </pre>,
    );
  }
  for (let k = pairs; k < added.length; k++) {
    rows.push(
      <pre key={`ae${k}`} className="ap-diff-add">
        + {added[k]}
      </pre>,
    );
  }
  return <>{rows}</>;
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
  pos,
  disabled,
  onSubmit,
  onClose,
}: {
  target: string | null;
  pos: { x: number; y: number };
  disabled: boolean;
  onSubmit: (text: string) => void;
  onClose: () => void;
}): JSX.Element {
  const [text, setText] = useState("");
  const [p, setP] = useState(pos);
  const box = useRef<HTMLDivElement>(null);
  const ta = useRef<HTMLTextAreaElement>(null);
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    ta.current?.focus();
  }, []);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (drag.current) setP({ x: e.clientX - drag.current.dx, y: e.clientY - drag.current.dy });
    };
    const up = () => {
      drag.current = null;
    };
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", up);
    return () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", up);
    };
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node) && !text.trim()) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [text, onClose]);

  const grow = (el: HTMLTextAreaElement) => {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 8 * 22)}px`;
  };

  const submit = () => {
    if (text.trim()) onSubmit(text.trim());
  };

  return (
    <div className="ap-composer ap-composer-float" ref={box} style={{ left: p.x, top: p.y, right: "auto" }}>
      <div className="ap-composer-head" onMouseDown={(e) => (drag.current = { dx: e.clientX - p.x, dy: e.clientY - p.y })}>
        <span className="ap-quote">{target ? `on “${target}”` : "document-level comment"}</span>
        <span className="ap-drag" title="drag to move">⠿</span>
      </div>
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
  synced: boolean;
  disabled: boolean;
  onFocus: () => void;
  onReply: (text: string) => void;
  onAnswer: (selected: string[], text: string) => void;
  onResolve: (resolved: boolean) => void;
  onEdit: (id: string, text: string) => void;
  onDelete: (id: string) => void;
}): JSX.Element {
  const { thread, body, disabled, orphaned } = props;
  const root = thread.root;
  const isDoc = root.anchor === "doc";
  // Doc comments carry no anchor, so skip the anchor/quote line entirely.
  const quote = isDoc ? null : orphaned ? "⚠ anchor removed (orphaned)" : (anchoredText(body, root.id) ?? "(anchor missing)");
  const [replyText, setReplyText] = useState("");
  const [replying, setReplying] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState("");
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null); // which comment's ⋯ menu is open

  // Close the ⋯ menu on any outside click (its own clicks stopPropagation).
  useEffect(() => {
    if (!menuOpenId) return;
    const onDoc = () => setMenuOpenId(null);
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [menuOpenId]);

  // One comment (the root or a reply): its text, with a per-comment ⋯ (Modify/Delete) menu.
  const renderComment = (c: Comment, isReply: boolean): JSX.Element => (
    <div className={isReply ? "ap-reply" : "ap-comment"} key={c.id}>
      <div className="ap-meta">
        {isReply ? "↳ " : ""}
        {c.author} · {c.date.slice(0, 16).replace("T", " ")}
      </div>
      {c.selected && c.selected.length > 0 && <div className="ap-selected">▶ {c.selected.join(", ")}</div>}
      {editingId === c.id ? (
        <div className="ap-edit">
          <textarea
            className="ap-grow"
            value={editText}
            autoFocus
            onChange={(e) => setEditText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                props.onEdit(c.id, editText);
                setEditingId(null);
              }
            }}
          />
          <div className="ap-row">
            <button
              onClick={() => {
                props.onEdit(c.id, editText);
                setEditingId(null);
              }}
            >
              Save
            </button>
            <button className="ap-link" onClick={() => setEditingId(null)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        c.text && <div className="ap-text">{c.text}</div>
      )}
      {!disabled && editingId !== c.id && (
        <div className="ap-cmenu">
          <button
            className="ap-cmenu-btn"
            title="More"
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpenId((id) => (id === c.id ? null : c.id));
            }}
          >
            ⋯
          </button>
          {menuOpenId === c.id && (
            <div className="ap-cmenu-pop" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setEditingId(c.id);
                  setEditText(c.text);
                  setMenuOpenId(null);
                }}
              >
                Modify
              </button>
              <button
                className="ap-danger"
                onClick={() => {
                  props.onDelete(c.id);
                  setMenuOpenId(null);
                }}
              >
                Delete
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );

  return (
    <article
      data-cmt-card={root.id}
      className={`ap-thread${props.focused ? " focused" : ""}${props.synced ? " synced" : ""}${root.resolved ? " resolved" : ""}${orphaned ? " orphaned" : ""}`}
      onClick={props.onFocus}
    >
      {quote && <div className="ap-thread-quote">{quote}</div>}
      {renderComment(root, false)}
      {root.question && <QuestionChips question={root.question} disabled={disabled} onAnswer={props.onAnswer} />}
      {thread.replies.map((r) => renderComment(r, true))}

      {/* Resolve is per thread; Reply opens a box with explicit Comment / Cancel. */}
      <div className="ap-row ap-thread-actions">
        <button className="ap-link" disabled={disabled} onClick={() => props.onResolve(!root.resolved)}>
          {root.resolved ? "Reopen thread" : "Resolve thread"}
        </button>
        {!replying && (
          <button className="ap-link" disabled={disabled} onClick={() => setReplying(true)}>
            Reply
          </button>
        )}
      </div>
      {replying && (
        <div className="ap-reply-box">
          <textarea
            className="ap-grow"
            placeholder="Reply…"
            value={replyText}
            disabled={disabled}
            autoFocus
            onChange={(e) => setReplyText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && replyText.trim()) {
                props.onReply(replyText.trim());
                setReplyText("");
                setReplying(false);
              }
            }}
          />
          <div className="ap-row">
            <button
              disabled={disabled || !replyText.trim()}
              onClick={() => {
                props.onReply(replyText.trim());
                setReplyText("");
                setReplying(false);
              }}
            >
              Comment
            </button>
            <button
              className="ap-link"
              onClick={() => {
                setReplyText("");
                setReplying(false);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}
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
