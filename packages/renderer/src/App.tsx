// SPDX-License-Identifier: AGPL-3.0-or-later

import { isDocComment, isSpanComment, LogEventType, parse, serialize, type Comment, type ParsedDocument, type Question } from "@inplan/core";
import { Fragment, type MouseEvent as ReactMouseEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hostApi, realHostApi, setApiOverride, type Acceptance, type Api, type Cadence, type ProfileState } from "./api";
import {
  addAnswer,
  addDocComment,
  addReply,
  addSpanComment,
  buildThreads,
  deleteComment,
  editCommentText,
  setResolved,
  spanCommentBlocker,
  type Thread,
} from "./docOps";
import { renderMarkdown } from "./markdown";
import { isInternalDocLink, resolveDocPath } from "./links";
import { ComposerPopover } from "./ComposerPopover";
import { ContextMenu } from "./ContextMenu";
import { MOD_KEY } from "./platform";
import { QuestionChips } from "./QuestionChips";
import { SourceEditor, type SourceEditorHandle } from "./SourceEditor";
import { StatusBar } from "./StatusBar";
import { ProfileMenu } from "./ProfileMenu";
import { AgentIndicator } from "./AgentIndicator";
import { IconBack, IconForward, IconUp, IconDown, IconSettings, IconZoomOut, IconZoomIn, IconFind, IconComment, IconSave, IconFinishTurn, IconRevealArchive } from "./Icons";
import { QuitDialog } from "./QuitDialog";
import { Onboarding, type OnboardingSignals } from "./Onboarding";
import { ONBOARDING_SAMPLE } from "./onboardingSample";
import { createMemoryApi } from "./memoryApi";
import { useT } from "./i18n";
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

/** Restart a one-shot CSS flash animation on `el` (remove → reflow → re-add) so it
 *  replays even on repeat clicks of the same comment. */
function flashEl(el: Element | null | undefined, cls: string): void {
  if (!el) return;
  el.classList.remove(cls);
  void (el as HTMLElement).offsetWidth; // force reflow so the animation restarts
  el.classList.add(cls);
}

/** Does the selection range intersect an already-rendered comment anchor? Catches
 *  overlaps that the source-text search can't (a selection crossing INTO an anchor
 *  can't be located verbatim, so it'd otherwise read as "not anchorable"). Falls back
 *  to false where Range.intersectsNode isn't available (then the source-text check runs). */
function selectionOverlapsComment(range: Range | null | undefined, root: HTMLElement | null): boolean {
  if (!range || !root || typeof range.intersectsNode !== "function") return false;
  for (const a of root.querySelectorAll("[data-cmt]")) {
    try {
      if (range.intersectsNode(a)) return true;
    } catch {
      /* detached node — ignore */
    }
  }
  return false;
}

type BlockReason = "whitespace" | "overlap" | "blocks" | "table" | "rendered";

/** Classify WHY an un-anchorable selection failed, from its DOM range, so the tooltip
 *  can be specific: it crosses table cells, spans multiple blocks, or hits rendered-only
 *  text (decoded entities / stripped markers) that has no single contiguous source span. */
function anchorFailureReason(range: Range | null | undefined): "blocks" | "table" | "rendered" {
  const elOf = (n: Node | null | undefined): Element | null => (n ? (n.nodeType === 1 ? (n as Element) : n.parentElement) : null);
  const s = elOf(range?.startContainer);
  const e = elOf(range?.endContainer);
  if (s?.closest("table") || e?.closest("table")) return "table";
  const sb = s?.closest("[data-line]");
  const eb = e?.closest("[data-line]");
  if (sb && eb && sb !== eb) return "blocks";
  return "rendered";
}

/** Why the selection can't become a comment (null = it can, or no selection → doc-level).
 *  Whitespace-only and overlapping selections are blocked; otherwise an un-anchorable
 *  span is classified by anchorFailureReason. */
function commentBlockReason(raw: string, body: string, range: Range | null | undefined, root: HTMLElement | null): BlockReason | null {
  if (!raw) return null;
  if (!raw.trim()) return "whitespace";
  if (selectionOverlapsComment(range, root)) return "overlap";
  const b = spanCommentBlocker(body, raw.trim());
  if (b === "overlap") return "overlap";
  if (b === "not-found") return anchorFailureReason(range);
  return null;
}

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

/** Props the onboarding wrapper (AppRoot) threads into the editor. All optional —
 *  the editor renders normally (and existing tests mount it bare) when they're absent. */
export interface EditorProps {
  /** First-run tour active: render the coach overlay + gate its comment steps. */
  onboarding?: boolean;
  /** The tour finished/skipped — AppRoot restores the real api and opens the real file. */
  onFinishOnboarding?: () => void;
  /** Wire a "Replay tutorial" item into the settings menu (real-doc phase only). */
  onReplayOnboarding?: () => void;
}

export function App(props: EditorProps = {}): JSX.Element {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [doc, setDoc] = useState<ParsedDocument>(EMPTY);
  const [cadence, setCadence] = useState<Cadence>("turn");
  const [acceptance, setAcceptance] = useState<Acceptance>("review"); // first-run default: agent parks edits for review
  const [autoResolve, setAutoResolve] = useState(false); // first-run default: leave threads for the human to resolve
  const [panes, setPanes] = useState<1 | 2 | 3>(2);
  const [rightTab, setRightTab] = useState<"comments" | "source">("comments");
  const [srcW, setSrcW] = useState(380); // source pane width (px) — drag-resizable
  const [cmtW, setCmtW] = useState(380); // comments pane width (px) — drag-resizable
  const [zoom, setZoom] = useState(1);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState("");
  const [agentThinking, setAgentThinking] = useState(false);
  const [agentDone, setAgentDone] = useState(false);
  const [agentMessages, setAgentMessages] = useState<{ text: string; ts: string }[]>([]);
  const [navState, setNavState] = useState<{ canBack: boolean; canForward: boolean }>({ canBack: false, canForward: false });
  const [reloadReady, setReloadReady] = useState(false); // agent signalled a new build is ready to load
  const [reloadIn, setReloadIn] = useState<number | null>(null); // seconds until auto-close (null = not counting)
  const [update, setUpdate] = useState<{ current: string; latest: string } | null>(null); // newer npm version
  const [updating, setUpdating] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [showResolvedOrphaned, setShowResolvedOrphaned] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [composer, setComposer] = useState<{ target: string | null; pos: { x: number; y: number } } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSel: boolean; hasRawSel: boolean; block: BlockReason | null } | null>(null);
  const [findSeed, setFindSeed] = useState(""); // pre-fills the find box (e.g. from the preview "Find text" menu item)
  const [focused, setFocused] = useState<string | null>(null);
  const [activePreviewLine, setActivePreviewLine] = useState<number | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false); // is the review panel visible (vs. parked behind a banner)
  const [findOpen, setFindOpen] = useState(false);
  const [findOpts, setFindOpts] = useState<{ query: string; ci: boolean; inPreview: boolean; inEditor: boolean; inComments: boolean }>({ query: "", ci: false, inPreview: true, inEditor: false, inComments: false });

  const docRef = useRef(doc);
  docRef.current = doc;
  const previewRef = useRef<HTMLElement>(null);
  const ctxBlockRef = useRef<HTMLElement | null>(null); // block under the last right-click (for "Select line")
  const ctxSelTextRef = useRef(""); // selection text captured at right-click (the menu acts on this, not a re-read)
  const tryAddCommentRef = useRef<() => void>(() => {}); // latest ⌘/Ctrl+/ handler (the keydown effect calls via this)
  const commentRangeRef = useRef<Range | null>(null); // the selection range being commented on (kept highlighted while composing)
  const docPathRef = useRef<string>(""); // current doc's locator path, for resolving relative links
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
      if (typeof s.srcW === "number") setSrcW(Math.min(900, Math.max(220, s.srcW)));
      if (typeof s.cmtW === "number") setCmtW(Math.min(900, Math.max(220, s.cmtW)));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    localStorage.setItem("ap-layout", JSON.stringify({ panes, rightTab, zoom, showResolvedOrphaned, cadence, acceptance, srcW, cmtW }));
  }, [panes, rightTab, zoom, showResolvedOrphaned, cadence, acceptance, srcW, cmtW]);

  // autoResolve is a global, cross-session user setting (affects agent behavior),
  // loaded from ~/.inplan/settings.json on launch — not localStorage.
  useEffect(() => {
    void hostApi().getSettings().then((s) => setAutoResolve(s.autoResolve));
  }, []);

  // --- load + agent signals ---
  useEffect(() => {
    const showProposal = (content: string) => {
      // The agent's version is parked in `.proposed.md`; review it against the
      // current (canonical) body. The working doc stays unchanged until Apply.
      setProposal({ baseBody: docRef.current.body, next: parse(content) });
      setReviewOpen(true);
      setAgentThinking(false);
      setStatus(t("msg.proposedReview"));
    };

    hostApi()
      .load()
      .then(({ content, path }) => {
        docPathRef.current = path;
        const d = parse(content);
        setDoc(d);
        savedRef.current = serialize(d);
        setLoaded(true);
        // Durable re-show: if a proposal was parked (e.g. the app was closed
        // mid-review), surface it again rather than silently accepting it.
        void hostApi().getProposal().then((parked) => parked != null && showProposal(parked));
      })
      .catch(() => setLoaded(true));

    // Auto-accept (and review-mode comment-only changes) arrive as a file rewrite.
    // Collect every host subscription's disposer so a remount (e.g. Replay tutorial)
    // can't stack ipcRenderer listeners and double-handle events.
    const subs: Array<(() => void) | void> = [
      hostApi().onExternalChange(({ content }) => {
        const next = parse(content);
        setAgentThinking(false);
        setDoc(next);
        savedRef.current = serialize(next);
        setDirty(false);
        setStatus(t("msg.agentUpdated"));
      }),
      // Review-mode body changes arrive parked, as a proposal to accept/reject.
      hostApi().onProposal(({ content }) => showProposal(content)),
      hostApi().onAgentDone(() => setAgentDone(true)),
      hostApi().onReload(() => {
        setReloadReady(true);
        setReloadIn(30); // start the auto-close countdown
      }),
      hostApi().onAgentActive(() => {
        setAgentThinking(false);
        setStatus(t("msg.agentTook"));
      }),
      // Human-facing notes the agent relays (via `inplan message`) — kept as a session
      // history, surfaced (latest first) in the status bar's click-to-open popup.
      hostApi().onAgentMessage?.((msg) => setAgentMessages((prev) => [...prev, msg])),
      // Desktop only: the window followed a link to another doc — reset to it (a fresh
      // load), clearing any in-flight proposal/turn state, then re-show a parked proposal.
      hostApi().onNavigated?.(({ content, path }) => {
        docPathRef.current = path;
        const d = parse(content);
        setDoc(d);
        savedRef.current = serialize(d);
        setDirty(false);
        setProposal(null);
        setReviewOpen(false);
        setAgentThinking(false);
        setAgentDone(false);
        setAgentMessages([]); // notes belong to the doc we just left — don't carry them over
        setStatus(`opened ${path.split("/").pop() ?? path}`);
        void hostApi().getProposal().then((parked) => parked != null && showProposal(parked));
      }),
      hostApi().onNavState?.((s) => setNavState(s)),
      // Desktop only: a newer npm version is available.
      hostApi().onUpdateAvailable?.((info) => setUpdate(info)),
    ];

    // Store the RAW selection (untrimmed) so a whitespace-only selection is distinguishable
    // from no selection at all (the former blocks commenting; the latter → doc-level).
    const onSel = () => setSelectionText(window.getSelection()?.toString() ?? "");
    document.addEventListener("selectionchange", onSel);
    return () => {
      document.removeEventListener("selectionchange", onSel);
      for (const dispose of subs) dispose?.();
    };
  }, []);

  // Reload countdown: once a new build is signalled, tick down and auto-close the
  // window at zero (the agent relaunches) — unless the user cancels first.
  useEffect(() => {
    if (reloadIn === null) return;
    if (reloadIn <= 0) {
      void hostApi().closeWindow();
      return;
    }
    const timer = setTimeout(() => setReloadIn((s) => (s === null ? null : s - 1)), 1000);
    return () => clearTimeout(timer);
  }, [reloadIn]);

  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) {
      setStatus(t("msg.nothingUndo"));
      return;
    }
    future.current.push(docRef.current);
    setDoc(prev);
    setDirty(serialize(prev) !== savedRef.current);
    setStatus(t("msg.undid"));
  }, []);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) {
      setStatus(t("msg.nothingRedo"));
      return;
    }
    history.current.push(docRef.current);
    setDoc(next);
    setDirty(serialize(next) !== savedRef.current);
    setStatus(t("msg.redid"));
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
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
        // ⌘F opens the find bar and focuses its input (even if already open).
        // (Inside the source editor, CodeMirror's own ⌘F is overridden in
        // SourceEditor to call this instead of its search panel.)
        e.preventDefault();
        setFindOpen(true);
        // Focus the find input AND select its current text, so re-pressing ⌘/Ctrl+F lets
        // you type over the previous query instead of appending to it.
        requestAnimationFrame(() => {
          const el = document.getElementById("ap-find-input") as HTMLInputElement | null;
          el?.focus();
          el?.select();
        });
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key === "/") {
        // ⌘/Ctrl+/ — add a comment on the selection (devs' "toggle comment" muscle memory).
        e.preventDefault();
        tryAddCommentRef.current();
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

  // Stuck-lock escape: while the editor is locked (the agent holds the turn), the
  // status bar reveals a "take back control" button on hover over "Agent is
  // thinking…", so a crashed or unresponsive agent can't strand the human in a
  // permanently locked editor. (Hover-gated so it doesn't clutter or jitter.)
  const takeBackControl = useCallback(() => {
    setAgentThinking(false);
    setStatus(t("msg.tookBack"));
    void hostApi().logAction(LogEventType.HumanReclaimed);
  }, []);

  // --- autosave ---
  useEffect(() => {
    if (!dirty || !loaded) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const delay = cadence === "instant" ? 5000 : 1500;
    autosaveTimer.current = setTimeout(() => {
      const content = serialize(docRef.current);
      if (cadence === "instant") {
        void hostApi().save(content, { kind: "canonical", cadence });
        savedRef.current = content;
        setDirty(false);
        setStatus(t("msg.autosaving"));
      } else {
        void hostApi().save(content, { kind: "backup", cadence });
        setStatus(t("msg.autosaved"));
      }
    }, delay);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [doc, dirty, loaded, cadence]);

  // Keep main informed of unsaved state so window-close can prompt Save/Don't Save.
  useEffect(() => {
    if (loaded) void hostApi().reportState(dirty, serialize(docRef.current));
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

  // The comment anchored on the active line (if any) — used only to *highlight*
  // the corresponding rail card. We intentionally do NOT scroll the rail here:
  // plain preview clicks / cursor moves must not move the rail. The rail scrolls
  // only on an explicit comment-anchor click (see focusComment).
  const syncedCommentId = useMemo(() => {
    if (activePreviewLine == null) return null;
    for (const c of doc.comments) {
      if (c.parentId || c.anchor === "doc") continue;
      if (anchorLine(doc.body, c.id) === activePreviewLine) return c.id;
    }
    return null;
  }, [activePreviewLine, doc.body, doc.comments]);

  // --- mutate helpers ---
  const apply = useCallback(
    (next: ParsedDocument, action?: { type: string; payload?: unknown }) => {
      history.current.push(docRef.current); // snapshot for undo
      if (history.current.length > 200) history.current.shift();
      future.current = [];
      const commentOnly = next.body === docRef.current.body; // body unchanged ⇒ a comment-thread change
      setDoc(next);
      if (action) void hostApi().logAction(action.type, action.payload);
      // Comment-thread changes are "always applied" — persist them immediately so
      // they survive reloads and proposals (incl. during review). In Instant mode
      // that's a canonical save (the agent reacts live); in Turn/Review it's a
      // *silent* save (no turn-end / no wake — comments don't end your turn).
      // Body edits (find/replace) keep the normal save flow.
      if (commentOnly) {
        const s = serialize(next);
        savedRef.current = s;
        setDirty(false);
        void hostApi().save(s, { kind: cadence === "instant" ? "canonical" : "apply", cadence });
      } else {
        setDirty(serialize(next) !== savedRef.current);
      }
    },
    [cadence],
  );

  const onModeChange = useCallback((c: Cadence, a: Acceptance) => {
    setCadence(c);
    setAcceptance(a);
    void hostApi().setMode(c, a);
  }, []);

  // Auto-resolve is a global directive to the agent: persist it to the settings
  // file and log the change (main does both) so the agent wakes and can honor it.
  const onAutoResolve = useCallback((v: boolean) => {
    setAutoResolve(v);
    void hostApi().setSettings({ autoResolve: v });
  }, []);

  const onZoom = useCallback((dir: -1 | 0 | 1) => {
    setZoom((z) => (dir === 0 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + dir * 0.1).toFixed(2)))));
  }, []);

  const saveNow = useCallback(() => {
    const content = serialize(docRef.current);
    const kind = cadence === "instant" ? "canonical" : "backup";
    void hostApi().save(content, { kind, cadence });
    if (kind === "canonical") {
      savedRef.current = content;
      setDirty(false);
    }
    setStatus(kind === "canonical" ? "saved" : "checkpoint saved");
  }, [cadence]);

  const finishTurn = useCallback(() => {
    const content = serialize(docRef.current);
    void hostApi().save(content, { kind: "canonical", cadence: "turn" });
    savedRef.current = content;
    setDirty(false);
    setAgentThinking(true);
    setStatus(t("msg.turnFinished"));
  }, []);

  const [quitOpen, setQuitOpen] = useState(false);
  const [forceSettingsOpen, setForceSettingsOpen] = useState(false); // onboarding opens the ⚙ menu on its settings step
  // Confirmed quit: the host saves (if asked), signals the agent (if asked), then leaves.
  const confirmQuit = useCallback((opts: { save: boolean; notifyComplete: boolean }) => {
    realHostApi().exit?.quit(serialize(docRef.current), opts);
    setQuitOpen(false);
  }, []);
  // The desktop window-close intercept is a HOST concern, so subscribe on the REAL host
  // (the onboarding sample has no onRequest). During the tour, closing just quits the
  // throwaway sample; otherwise it raises the quit-confirmation dialog. The returned
  // disposer prevents the listener from stacking across the onboarding → real remount.
  useEffect(() => {
    const real = realHostApi();
    return real?.exit?.onRequest?.(() => {
      if (props.onboarding) real.exit?.quit("", { save: false, notifyComplete: false });
      else setQuitOpen(true);
    });
  }, [props.onboarding]);

  // --- comment actions ---
  const addComment = useCallback(
    (text: string, target: string | null, question?: Question) => {
      if (target) {
        // Guard against an un-anchorable or OVERLAPPING span (nested links would
        // corrupt the doc) even if the UI's disabled state was bypassed.
        const blocker = spanCommentBlocker(docRef.current.body, target);
        if (blocker) {
          setStatus(blocker === "overlap" ? t("topbar.cantOverlap") : t("msg.cantAnchor"));
          return;
        }
        const res = addSpanComment(docRef.current, target, { text, author: USER_AUTHOR, question });
        if (!res) {
          setStatus(t("msg.cantAnchor"));
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

  const reportFind = useCallback((o: { query: string; ci: boolean; inPreview: boolean; inEditor: boolean; inComments: boolean }) => setFindOpts(o), []);

  const openComposer = useCallback(() => {
    const sel = window.getSelection();
    const txt = sel?.toString().trim() ?? "";
    if (txt && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      commentRangeRef.current = range.cloneRange(); // keep the span highlighted while composing (item 4)
      const r = range.getBoundingClientRect();
      setComposer({ target: txt, pos: { x: Math.max(8, Math.min(r.left, window.innerWidth - 360)), y: Math.max(48, Math.min(r.bottom + 6, window.innerHeight - 220)) } });
    } else {
      commentRangeRef.current = null;
      previewRef.current?.scrollTo({ top: 0 });
      setComposer({ target: null, pos: { x: 24, y: 56 } });
    }
  }, []);

  // Open the composer from the selection captured at right-click time (not a live
  // re-read) — clicking a menu item can collapse the page selection in some browsers,
  // so the right-click handler stashes the text + range and we use those here.
  const openComposerFromCapture = useCallback(() => {
    const target = ctxSelTextRef.current;
    if (target && commentRangeRef.current) {
      const r = commentRangeRef.current.getBoundingClientRect();
      setComposer({ target, pos: { x: Math.max(8, Math.min(r.left, window.innerWidth - 360)), y: Math.max(48, Math.min(r.bottom + 6, window.innerHeight - 220)) } });
    } else {
      commentRangeRef.current = null;
      previewRef.current?.scrollTo({ top: 0 });
      setComposer({ target: null, pos: { x: 24, y: 56 } });
    }
  }, []);

  // Select a DOM node's text contents (used by the preview context menu's
  // "Select line" / "Select all"). Replaces the current selection.
  const selectNodeContents = useCallback((node: Node | null) => {
    if (!node) return;
    const sel = window.getSelection();
    if (!sel) return;
    const r = document.createRange();
    r.selectNodeContents(node);
    sel.removeAllRanges();
    sel.addRange(r);
  }, []);

  // Keep the commented span visibly highlighted while the composer is open — focusing
  // the composer textarea collapses the DOM selection, so paint a persistent CSS Custom
  // Highlight over the captured range instead (item 4). No-op where the API is absent
  // (happy-dom tests / older engines).
  useEffect(() => {
    const cssApi = CSS as unknown as { highlights?: Map<string, unknown> };
    const HighlightCtor = (window as unknown as { Highlight?: new (...r: Range[]) => unknown }).Highlight;
    if (!cssApi.highlights || !HighlightCtor) return;
    cssApi.highlights.delete("ap-comment-target");
    if (composer && commentRangeRef.current) {
      try {
        cssApi.highlights.set("ap-comment-target", new HighlightCtor(commentRangeRef.current) as unknown);
      } catch {
        /* range detached (doc changed) — nothing to paint */
      }
    }
    return () => void cssApi.highlights?.delete("ap-comment-target");
  }, [composer]);

  // Clear the find seed once the bar closes, so a later ⌘/Ctrl+F opens empty (the seed
  // only pre-fills a fresh open from the preview "Find text" menu item).
  useEffect(() => {
    if (!findOpen) setFindSeed("");
  }, [findOpen]);

  // --- cross-pane sync ---
  const syncToLine = useCallback((line: number) => {
    skipPreviewScroll.current = true; // the user clicked in the preview; don't re-scroll it
    setActivePreviewLine(line);
    editorRef.current?.scrollToLine(line);
  }, []);

  const focusComment = useCallback(
    (id: string, fromPreview = false, fromRail = false) => {
      setFocused(id);
      const line = anchorLine(docRef.current.body, id);
      if (line != null) editorRef.current?.scrollToLine(line);
      const c = docRef.current.comments.find((x) => x.id === id);
      const rootId = c?.parentId ?? id; // the anchor + rail card live on the thread root
      const isDoc = docRef.current.comments.find((x) => x.id === rootId)?.anchor === "doc";
      // Re-center the anchor in the preview only when focus came from another pane (the
      // rail). If the user clicked the anchor in the preview itself, don't yank the pane.
      if (!fromPreview && !isDoc) previewRef.current?.querySelector(`[data-cmt="${rootId}"]`)?.scrollIntoView({ block: "center" });
      // Flash the target to draw the eye after the scroll: the anchored span pulses
      // (darker → normal), or the whole document washes the comment tint for doc-level.
      if (isDoc) flashEl(previewRef.current?.querySelector(".ap-rendered"), "ap-flash-doc");
      else flashEl(previewRef.current?.querySelector(`[data-cmt="${rootId}"]`), "ap-flash-anchor");
      // Reveal the thread in the rail ONLY when focus came from elsewhere (a preview
      // anchor or a find match). When the user clicked the card in the rail itself, never
      // scroll the rail — they're already looking at it (a long comment would otherwise jump).
      if (fromRail) return;
      const card = railRef.current?.querySelector(`[data-cmt-card="${rootId}"]`);
      if (card) {
        const parts = card.querySelectorAll(".ap-comment, .ap-reply");
        (parts[parts.length - 1] ?? card).scrollIntoView({ block: "nearest" });
      }
    },
    [],
  );

  // Jump to a find match: body matches select in the source editor (revealing it)
  // and scroll the preview; comment matches focus the comment thread.
  const navigateMatch = useCallback(
    (m: FindMatch) => {
      if (m.scope === "comment") {
        focusComment(m.id);
        return;
      }
      const line = docRef.current.body.slice(0, m.from).split("\n").length - 1;
      setActivePreviewLine(line);
      if (findOpts.inEditor) {
        // Editor scope: select + center the match in the source pane.
        if (panes === 2) setRightTab("source");
        editorRef.current?.selectRange(m.from, m.to);
      } else {
        // Preview scope: scroll the rendered block to center — directly, every
        // navigation (don't rely on the active-line effect, which only fires when
        // the line *changes*, so same-line matches wouldn't scroll).
        const root = previewRef.current;
        if (root) {
          let best: Element | null = null;
          let bl = -1;
          root.querySelectorAll("[data-line]").forEach((el) => {
            const l = Number(el.getAttribute("data-line") ?? -1);
            if (l <= line && l >= bl) {
              bl = l;
              best = el;
            }
          });
          (best as Element | null)?.scrollIntoView({ block: "center" });
        }
      }
    },
    [panes, focusComment, findOpts.inEditor],
  );

  // --- review apply ---
  const applyProposal = useCallback(
    (segs: DiffSegment[], accepted: boolean[]) => {
      if (!proposal || editingLocked) return; // can't apply while the agent holds the turn
      const body = applySegments(segs, accepted);
      // Merge comments rather than overwrite with the proposal's stale snapshot:
      // keep everything in the live doc (incl. comments the human added during
      // review) and append any agent-proposed comments not already present, so
      // accepting a proposal never discards review-time comments.
      const live = docRef.current.comments;
      const have = new Set(live.map((c) => c.id));
      const merged = [...live, ...proposal.next.comments.filter((c) => !have.has(c.id))];
      // Safety net: a span comment whose anchor link didn't survive into the
      // accepted body (e.g. added during review) would make the doc invalid —
      // demote it to a doc-level comment instead of corrupting the document.
      const comments = merged.map((c) => (!c.parentId && c.anchor !== "doc" && !body.includes(`](#${c.id})`) ? { ...c, anchor: "doc" as const } : c));
      const finalDoc: ParsedDocument = { body, comments };
      setDoc(finalDoc);
      setProposal(null);
      setReviewOpen(false);
      const serialized = serialize(finalDoc);
      savedRef.current = serialized;
      setDirty(false);
      const acceptedCount = accepted.filter(Boolean).length;
      // Decision made → persist canonical *silently* (accepting a proposal must
      // not end your turn) and discard the parked proposal.
      void hostApi().save(serialized, { kind: "apply", cadence });
      void hostApi().clearProposal();
      void hostApi().logAction(acceptedCount === accepted.length ? "revision_accepted_all" : acceptedCount === 0 ? "revision_rejected_all" : "revision_hunk_accepted", { accepted: acceptedCount, total: accepted.length });
      setStatus(`applied agent revision (${acceptedCount}/${accepted.length} hunks)`);
    },
    [proposal, cadence, editingLocked],
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

  // "Review next": step through change hunks, scrolling each into view (in both
  // the preview and, when shown, the source diff) and highlighting it.
  const [reviewCursor, setReviewCursor] = useState(-1);
  useEffect(() => setReviewCursor(-1), [proposal]);
  const reviewNext = useCallback(() => {
    if (!changeCount) return;
    const n = (reviewCursor + 1) % changeCount;
    setReviewCursor(n);
    // Surface the source diff too (2-pane shows one side) so the SAME change is
    // visible in both panes, then center the hunk in each.
    if (panes === 2 && rightTab !== "source") setRightTab("source");
    // Top-align the hunk in BOTH panes (block:"start"): a hunk taller than the
    // pane would, with block:"center", scroll its middle to the centre and push
    // its top off-screen — so the change appears not to have scrolled into view.
    // Aligning the top to the pane top shows the start of the diff in each pane.
    requestAnimationFrame(() => {
      previewRef.current?.querySelector(`[data-hunk="${n}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
      document.querySelector(`.ap-diffsource [data-hunk="${n}"]`)?.scrollIntoView({ block: "start", behavior: "smooth" });
    });
  }, [changeCount, reviewCursor, panes, rightTab]);

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
  const resolvedCount = ordered.filter((o) => o.thread.root.resolved).length;
  const orphanedCount = ordered.filter((o) => o.orphaned).length;
  // Reveal-toggle tooltip: only name the categories that actually have hidden comments
  // (the button itself is hidden when both counts are 0 — nothing to reveal).
  const revealTip =
    resolvedCount > 0 && orphanedCount > 0
      ? t("rail.showResolved", { resolved: resolvedCount, orphaned: orphanedCount })
      : resolvedCount > 0
        ? t("rail.showResolvedOnly", { resolved: resolvedCount })
        : t("rail.showOrphanedOnly", { orphaned: orphanedCount });
  // Why the current selection can't be commented on (null = it can, or no selection).
  const selBlocker = useMemo<BlockReason | null>(() => {
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    return commentBlockReason(selectionText, doc.body, range, previewRef.current);
  }, [doc.body, selectionText]);
  // Map a block reason to its tooltip / status message.
  const blockerTip = useCallback(
    (r: BlockReason | null): string | null => {
      switch (r) {
        case "whitespace": return t("topbar.cantWhitespace");
        case "overlap": return t("topbar.cantOverlap");
        case "blocks": return t("topbar.cantSpanBlocks");
        case "table": return t("topbar.cantSpanTable");
        case "rendered": return t("topbar.cantRendered");
        default: return null;
      }
    },
    [t],
  );
  // ⌘/Ctrl+/ entry point: open the composer unless the selection is blocked (then explain).
  const tryAddComment = useCallback(() => {
    const sel = window.getSelection();
    const raw = sel?.toString() ?? "";
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
    const reason = commentBlockReason(raw, docRef.current.body, range, previewRef.current);
    if (reason) {
      setStatus(blockerTip(reason) ?? "");
      return;
    }
    openComposer();
  }, [blockerTip, openComposer]);
  tryAddCommentRef.current = tryAddComment; // keep the keydown handler pointing at the latest

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
    // Preview + comments highlight here (CSS Custom Highlight); the Editor scope
    // highlights inside CodeMirror via the SourceEditor `find` prop instead.
    if (findOpts.inPreview && previewRef.current) collect(previewRef.current);
    if (findOpts.inComments && railRef.current) railRef.current.querySelectorAll(".ap-text").forEach((el) => collect(el));
    if (ranges.length) cssApi.highlights.set("ap-find", new HighlightCtor(...ranges));
  }, [findOpts, findOpen, previewHtml, doc.comments]);

  // Counts the first-run tour watches to know when a step's action has been done.
  // (Declared before the early return below so the hook order stays stable.)
  const onboardingSignals = useMemo<OnboardingSignals>(
    () => ({
      inline: doc.comments.filter(isSpanComment).length,
      doc: doc.comments.filter(isDocComment).length,
      answered: doc.comments.filter((c) => c.selected !== undefined).length,
    }),
    [doc.comments],
  );

  if (!loaded) return <div className="ap-loading">{t("app.loading")}</div>;

  // 1 pane = preview only; 2 panes = preview + one of {source, comments} (tabbed);
  // 3 panes = preview + source + comments.
  const showSource = panes === 3 || (panes === 2 && rightTab === "source");
  const showComments = panes === 3 || (panes === 2 && rightTab === "comments");

  // Prev/Next-thread navigation in the comments rail head: step focus through the
  // visible threads in order, disabling at the first/last. `focused` may hold a reply
  // id (e.g. a find-in-comments match), so resolve it to its thread root before matching.
  const focusedRootId = (() => {
    // Walk the whole parentId chain to the top-level root — a reply-to-reply must
    // still resolve to its thread root (a single hop would land on an intermediate
    // reply that never matches o.thread.root.id). Guard against cyclic parentIds.
    const byId = new Map(doc.comments.map((x) => [x.id, x]));
    let id = focused;
    const seen = new Set<string>();
    let c = id ? byId.get(id) : undefined;
    while (c?.parentId && !seen.has(c.parentId)) {
      seen.add(c.parentId);
      id = c.parentId;
      c = byId.get(id);
    }
    return id;
  })();
  const focusedIdx = visible.findIndex((o) => o.thread.root.id === focusedRootId);
  const gotoThread = (dir: -1 | 1) => {
    if (visible.length === 0) return;
    const ni = (focusedIdx < 0 ? (dir === 1 ? -1 : visible.length) : focusedIdx) + dir;
    if (ni >= 0 && ni < visible.length) focusComment(visible[ni]!.thread.root.id);
  };

  return (
    <div className="ap-app">
      <TopBar
        cadence={cadence}
        acceptance={acceptance}
        autoResolve={autoResolve}
        panes={panes}
        zoom={zoom}
        hasSelection={selectionText.length > 0}
        commentBlockTip={blockerTip(selBlocker)}
        onMode={onModeChange}
        onAutoResolve={onAutoResolve}
        onPanes={setPanes}
        onZoom={onZoom}
        onAddComment={openComposer}
        onToggleFind={() => setFindOpen((v) => !v)}
        dirty={dirty}
        onSave={saveNow}
        onFinishTurn={finishTurn}
        onBack={hostApi().exit?.showBackButton ? () => setQuitOpen(true) : undefined}
        onReplayTutorial={
          props.onReplayOnboarding
            ? () => {
                // Replaying remounts the editor (discarding in-memory state); persist any
                // unsaved edits first — a silent canonical write (no agent wake) so the
                // post-tour reload restores them.
                if (dirty) void hostApi().save(serialize(docRef.current), { kind: "apply", cadence });
                props.onReplayOnboarding!();
              }
            : undefined
        }
        forceSettingsOpen={forceSettingsOpen}
        locked={editingLocked}
        nav={
          typeof hostApi().navigate === "function"
            ? { canBack: navState.canBack, canForward: navState.canForward, onBack: () => void hostApi().navigate?.("back"), onForward: () => void hostApi().navigate?.("forward") }
            : undefined
        }
      />

      {findOpen && (
        <FindReplaceBar
          doc={doc}
          seed={findSeed}
          onApply={apply}
          onClose={() => setFindOpen(false)}
          onNavigate={navigateMatch}
          onQuery={reportFind}
        />
      )}

      {agentDone && (
        <div className="ap-banner">
          {t("banner.agentReady")}{" "}
          <button className="ap-link" onClick={() => setAgentDone(false)}>
            {t("banner.dismiss")}
          </button>
        </div>
      )}

      {reloadReady && (
        <div className="ap-banner ap-banner-reload">
          {t("banner.newBuild")} <strong>{t("banner.reloadingIn", { n: reloadIn ?? 0 })}</strong>{" "}
          <span className="ap-spacer" />
          <button className="ap-primary" onClick={() => void hostApi().closeWindow()}>
            {t("banner.reloadNow")}
          </button>
          <button
            className="ap-link"
            onClick={() => {
              setReloadIn(null); // cancel the countdown
              setReloadReady(false);
            }}
          >
            {t("banner.cancel")}
          </button>
        </div>
      )}

      {update && (
        <div className="ap-banner">
          {updating === "done" ? (
            <>
              {t("banner.updated")} <strong>v{update.latest}</strong> {t("banner.restartToApply")}
              <span className="ap-spacer" />
              <button className="ap-primary" onClick={() => void hostApi().closeWindow()}>
                {t("banner.restart")}
              </button>
            </>
          ) : (
            <>
              {t("banner.newVersion")} (<strong>v{update.current} → v{update.latest}</strong>).
              {updating === "failed" && <span className="ap-update-err"> {t("banner.updateFailed")}</span>}
              <span className="ap-spacer" />
              <button
                className="ap-primary"
                disabled={updating === "running"}
                onClick={async () => {
                  setUpdating("running");
                  const r = await hostApi().applyUpdate?.();
                  setUpdating(r?.ok ? "done" : "failed");
                }}
              >
                {updating === "running" ? t("banner.updating") : t("banner.updateNow")}
              </button>
              <button className="ap-link" onClick={() => setUpdate(null)}>
                {t("banner.later")}
              </button>
            </>
          )}
        </div>
      )}

      {proposal && !reviewOpen && (
        <div className="ap-banner">
          {t("banner.proposalPending")}{" "}
          <button onClick={() => setReviewOpen(true)}>{t("banner.review")}</button>
        </div>
      )}

      {proposal && reviewOpen && (
        <div className="ap-review-bar">
          <strong>{t("banner.proposedChanges")}</strong>{" "}
          {t(changeCount === 1 ? "banner.changesShown" : "banner.changesShownPlural", { n: changeCount })}
          <span className="ap-spacer" />
          <button onClick={reviewNext} disabled={!changeCount} title={t("banner.scrollToNext")}>
            {t("banner.reviewNext")}
            {reviewCursor >= 0 ? ` (${reviewCursor + 1}/${changeCount})` : ""}
          </button>
          <button disabled={editingLocked} onClick={() => setAccepted(new Array(changeCount).fill(true))}>
            {t("banner.acceptAll")}
          </button>
          <button disabled={editingLocked} onClick={() => setAccepted(new Array(changeCount).fill(false))}>
            {t("banner.rejectAll")}
          </button>
          <button className="ap-primary" disabled={editingLocked} onClick={applyReview}>
            {t("banner.apply")}
          </button>
          <button className="ap-link" onClick={() => setReviewOpen(false)}>
            {t("banner.laterLower")}
          </button>
          {editingLocked && <span className="ap-muted">{t("banner.locked")}</span>}
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

      {quitOpen && (
        <QuitDialog
          fileName={docPathRef.current ? docPathRef.current.split(/[\\/]/).pop() || null : null}
          dirty={dirty}
          onQuit={confirmQuit}
          onCancel={() => setQuitOpen(false)}
        />
      )}

      {props.onboarding && props.onFinishOnboarding && (
        <Onboarding signals={onboardingSignals} onFinish={props.onFinishOnboarding} onActiveStep={(id) => setForceSettingsOpen(id === "settings")} />
      )}

      {ctxMenu && (
        <ContextMenu
          pos={{ x: ctxMenu.x, y: ctxMenu.y }}
          onClose={() => setCtxMenu(null)}
          items={[
            {
              // A (raw) selection ⇒ "Add Comment" (matching the top bar — a whitespace-only
              // selection is a blocked *selection*, shown disabled with its reason, not doc-level).
              // No selection at all ⇒ this posts a document-level comment, so name it as such.
              label: ctxMenu.hasRawSel ? t("topbar.addComment") : t("topbar.addDocComment"),
              disabled: editingLocked || ctxMenu.block !== null,
              ...(ctxMenu.block ? { title: blockerTip(ctxMenu.block) ?? "" } : {}),
              onSelect: openComposerFromCapture,
            },
            { label: t("menu.findText"), disabled: !ctxMenu.hasSel, onSelect: () => { setFindSeed(ctxSelTextRef.current); setFindOpen(true); } },
            { label: t("menu.copy"), disabled: !ctxMenu.hasSel, onSelect: () => void navigator.clipboard?.writeText?.(ctxSelTextRef.current) },
            { label: t("menu.selectLine"), disabled: !ctxBlockRef.current, onSelect: () => selectNodeContents(ctxBlockRef.current) },
            { label: t("menu.selectAll"), onSelect: () => selectNodeContents(previewRef.current) },
          ]}
        />
      )}

      <div className="ap-main" style={{ zoom }}>
        <section className="ap-preview" ref={previewRef} data-onboard="preview">
          {proposal && reviewOpen ? (
            <DiffPreview segs={reviewSegs} accepted={accepted} focused={reviewCursor} onToggle={toggleHunk} />
          ) : (
          <div
            className="ap-rendered"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
            onContextMenu={(e) => {
              e.preventDefault();
              // Capture the selection (text + range) and the block under the cursor NOW —
              // clicking a menu item can collapse the selection in some browsers, so the
              // menu acts on what was captured here, not a later re-read.
              ctxBlockRef.current = (e.target as HTMLElement).closest("[data-line]") as HTMLElement | null;
              const sel = window.getSelection();
              const raw = sel?.toString() ?? "";
              const trimmed = raw.trim();
              const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0) : null;
              ctxSelTextRef.current = trimmed; // find/copy/anchor act on the trimmed text
              commentRangeRef.current = trimmed && range ? range.cloneRange() : null;
              const block = commentBlockReason(raw, docRef.current.body, range, previewRef.current);
              setCtxMenu({ x: Math.max(8, Math.min(e.clientX, window.innerWidth - 200)), y: Math.max(8, Math.min(e.clientY, window.innerHeight - 220)), hasSel: trimmed.length > 0, hasRawSel: raw.length > 0, block });
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
                if (isInternalDocLink(href)) {
                  void hostApi().openDoc(resolveDocPath(docPathRef.current, href));
                  return;
                }
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
          <>
            <VSplitter width={srcW} setWidth={setSrcW} />
          <section className="ap-pane" style={{ width: srcW }}>
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            {proposal && reviewOpen ? (
              <DiffSource segs={reviewSegs} accepted={accepted} focused={reviewCursor} onToggle={toggleHunk} />
            ) : (
              <SourceEditor
                ref={editorRef}
                collab={hostApi().collab ?? null}
                value={doc.body}
                editable={!editingLocked}
                onChange={(body) => {
                  // Typing has its own (CodeMirror) undo; don't push app-level history per keystroke.
                  const nd = { ...docRef.current, body };
                  setDoc(nd);
                  setDirty(serialize(nd) !== savedRef.current);
                }}
                onCursorLine={(line) => setActivePreviewLine(line)}
                onFind={() => setFindOpen(true)}
                find={findOpen && findOpts.inEditor && findOpts.query ? { query: findOpts.query, ci: findOpts.ci } : null}
              />
            )}
          </section>
          </>
        )}

        {showComments && (
          <>
            <VSplitter width={cmtW} setWidth={setCmtW} />
          <section className="ap-pane ap-rail" ref={railRef} style={{ width: cmtW }} data-onboard="comments">
            {panes === 2 && <PaneTabs tab={rightTab} onTab={setRightTab} />}
            <div className="ap-rail-scroll">
            <div className="ap-rail-head">
              <strong>{t("rail.comments")}</strong>
              <div className="ap-rail-tools">
                {visible.length > 0 && (
                  <div className="ap-seg" role="group" aria-label="comment threads">
                    <button type="button" title={t("rail.prevThread")} aria-label={t("rail.prevThread")} disabled={focusedIdx === 0} onClick={() => gotoThread(-1)}>
                      <IconUp />
                    </button>
                    <button type="button" title={t("rail.nextThread")} aria-label={t("rail.nextThread")} disabled={focusedIdx === visible.length - 1} onClick={() => gotoThread(1)}>
                      <IconDown />
                    </button>
                  </div>
                )}
                {(resolvedCount > 0 || orphanedCount > 0) && (
                  <button
                    type="button"
                    className={`ap-iconbtn ap-reveal${showResolvedOrphaned ? " on" : ""}`}
                    aria-pressed={showResolvedOrphaned}
                    title={revealTip}
                    aria-label={revealTip}
                    onClick={() => setShowResolvedOrphaned((v) => !v)}
                  >
                    <IconRevealArchive />
                  </button>
                )}
              </div>
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
                  onFocus={() => focusComment(o.thread.root.id, false, true)}
                  onReply={(text) => apply(addReply(docRef.current, o.thread.root.id, text, USER_AUTHOR).doc, { type: "comment_created", payload: { parentId: o.thread.root.id } })}
                  onAnswer={(selected, text) => apply(addAnswer(docRef.current, o.thread.root.id, selected, text, USER_AUTHOR).doc, { type: "comment_answered", payload: { parentId: o.thread.root.id, selected } })}
                  onResolve={(r) => apply(setResolved(docRef.current, o.thread.root.id, r), { type: "comment_resolved", payload: { id: o.thread.root.id, resolved: r } })}
                  onEdit={(id, text) => apply(editCommentText(docRef.current, id, text), { type: "comment_modified", payload: { id } })}
                  onDelete={(id) => apply(deleteComment(docRef.current, id), { type: "comment_deleted", payload: { id } })}
                />
              </Fragment>
            ))}
            {visible.length === 0 && <div className="ap-empty">No comments. Select text and use “+ Add Comment”.</div>}
            </div>
          </section>
          </>
        )}
      </div>

      <StatusBar
        cadence={cadence}
        status={status}
        dirty={dirty}
        agentThinking={agentThinking}
        messages={agentMessages}
        canTakeBack={editingLocked}
        onTakeBack={takeBackControl}
      />
    </div>
  );
}

const ONBOARDED_KEY = "ap-onboarded";

/** Host entry point. On first run it swaps `hostApi()` for a throwaway in-memory
 *  sample and runs the guided tour, so practice edits never touch the real document;
 *  on finish it restores the host api and remounts the editor on the real file. Both
 *  the desktop and web hosts mount THIS (not the bare editor). */
export function AppRoot(): JSX.Element {
  const installedRef = useRef(false); // guards the override install against StrictMode's double-invoke
  const [phase, setPhase] = useState<"onboarding" | "real">(() => {
    try {
      return localStorage.getItem(ONBOARDED_KEY) ? "real" : "onboarding";
    } catch {
      return "real"; // storage blocked (private mode) → skip the tour rather than loop it
    }
  });
  const [apiReady, setApiReady] = useState(phase === "real");

  const installSample = useCallback(() => {
    const sample = createMemoryApi({ content: ONBOARDING_SAMPLE, settings: { autoResolve: false } }).api;
    sample.i18n = (window as unknown as { api?: Api }).api?.i18n; // keep the user's locale during the tour
    setApiOverride(sample);
  }, []);

  // First-run: install the sample override before the editor mounts (so its load reads the sample).
  useEffect(() => {
    if (phase !== "onboarding" || installedRef.current) return;
    installedRef.current = true;
    installSample();
    setApiReady(true);
  }, [phase, installSample]);

  const finish = useCallback(() => {
    try {
      localStorage.setItem(ONBOARDED_KEY, "1");
    } catch {
      /* private mode — the tour will show again next launch, which is acceptable */
    }
    setApiOverride(null); // back to the real host
    setPhase("real");
    setApiReady(true);
  }, []);

  const replay = useCallback(() => {
    installSample(); // install synchronously — this is a user action, not a double-invoked effect
    setPhase("onboarding");
    setApiReady(true);
  }, [installSample]);

  if (!apiReady) return <div className="ap-app" />; // one tick while the sample override is installed

  return phase === "onboarding" ? <App key="onboarding" onboarding onFinishOnboarding={finish} /> : <App key="real" onReplayOnboarding={replay} />;
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
  onReplayTutorial,
  forceOpen,
}: {
  acceptance: Acceptance;
  autoResolve: boolean;
  onAcceptance: (a: Acceptance) => void;
  onAutoResolve: (v: boolean) => void;
  onReplayTutorial?: () => void;
  forceOpen?: boolean; // onboarding holds the menu open on the settings step
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const t = useT();
  const isOpen = forceOpen || open; // forceOpen (onboarding) overrides the outside-click close
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!forceOpen && ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [forceOpen]);
  return (
    <div className="ap-settings" ref={ref}>
      <button data-onboard="settings" title={t("settings.title")} aria-label={t("settings.title")} aria-expanded={isOpen} onClick={() => setOpen((v) => !v)}>
        <IconSettings />
      </button>
      {isOpen && (
        <div className="ap-settings-menu">
          <div className="ap-settings-row">
            <span>{t("settings.agentChanges")}</span>
            <div className="ap-seg">
              <button className={acceptance === "auto" ? "active" : ""} onClick={() => onAcceptance("auto")}>
                {t("settings.autoAccept")}
              </button>
              <button className={acceptance === "review" ? "active" : ""} onClick={() => onAcceptance("review")}>
                {t("settings.review")}
              </button>
            </div>
          </div>
          <label className="ap-settings-row">
            <span>{t("settings.autoResolve")}</span>
            <input type="checkbox" checked={autoResolve} onChange={(e) => onAutoResolve(e.target.checked)} />
          </label>
          <div className="ap-settings-hint">{t("settings.autoResolveHint")}</div>
          {onReplayTutorial && (
            <button
              className="ap-settings-replay"
              onClick={() => {
                setOpen(false);
                onReplayTutorial();
              }}
            >
              {t("settings.replayTutorial")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// Draggable vertical splitter sitting on a side pane's left edge. Dragging left
// widens the pane to its right (the flexible preview absorbs the rest).
function VSplitter({ width, setWidth }: { width: number; setWidth: (w: number) => void }): JSX.Element {
  const t = useT();
  const onDown = (e: ReactMouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    const onMove = (ev: MouseEvent) => setWidth(Math.max(220, Math.min(900, startW + (startX - ev.clientX))));
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize";
  };
  return <div className="ap-vsplit" onMouseDown={onDown} title={t("splitter.resize")} role="separator" aria-orientation="vertical" />;
}

function PaneTabs({ tab, onTab }: { tab: "comments" | "source"; onTab: (t: "comments" | "source") => void }): JSX.Element {
  const t = useT();
  return (
    <div className="ap-tabs">
      <button className={tab === "comments" ? "active" : ""} onClick={() => onTab("comments")}>
        {t("tabs.comments")}
      </button>
      <button className={tab === "source" ? "active" : ""} onClick={() => onTab("source")}>
        {t("tabs.source")}
      </button>
    </div>
  );
}

/** Subscribe to the host's profile controller (identity + live agent presence).
 *  Returns null when the host wires no profile (tests / single-writer desktop).
 *  Uses state-push rather than `useSyncExternalStore` because a host may proxy the
 *  controller across a contextBridge (Electron), where `get()` need not return a
 *  referentially stable snapshot. */
function useProfile(): ProfileState | null {
  const controller = hostApi().profile;
  const [state, setState] = useState<ProfileState | null>(() => controller?.get() ?? null);
  useEffect(() => {
    if (!controller) return;
    setState(controller.get());
    return controller.subscribe(setState);
  }, [controller]);
  return state;
}

function TopBar(props: {
  cadence: Cadence;
  acceptance: Acceptance;
  autoResolve: boolean;
  panes: 1 | 2 | 3;
  zoom: number;
  hasSelection: boolean;
  commentBlockTip: string | null; // why Add Comment is disabled (tooltip text), or null if allowed
  onMode: (c: Cadence, a: Acceptance) => void;
  onAutoResolve: (v: boolean) => void;
  onPanes: (p: 1 | 2 | 3) => void;
  onZoom: (dir: -1 | 0 | 1) => void;
  onAddComment: () => void;
  onToggleFind: () => void;
  dirty: boolean;
  onSave: () => void;
  onFinishTurn: () => void;
  onBack?: () => void; // web: return to the plan list (desktop quits via the OS window close)
  onReplayTutorial?: () => void; // settings menu: re-run the first-run tour
  forceSettingsOpen?: boolean; // onboarding: hold the ⚙ menu open on the settings step
  locked: boolean;
  nav?: { canBack: boolean; canForward: boolean; onBack: () => void; onForward: () => void };
}): JSX.Element {
  const { cadence, acceptance, panes, onMode } = props;
  const profile = useProfile();
  const t = useT();
  // In a presence-aware host (web/cloud), no attached agent ⇒ Instant + Finish-turn
  // are disabled (there's nothing to hand the turn to). The desktop's local agent is
  // implicit, so it isn't presence-aware and these stay enabled.
  const noAgent = profile?.presenceAware === true && profile.agentLocation == null;
  const noAgentTitle = noAgent ? t("topbar.noAgent") : undefined;
  return (
    <header className="ap-topbar">
      {props.onBack && (
        <button className="ap-iconbtn ap-iconbtn--primary" onClick={props.onBack} title={t("topbar.back")} aria-label={t("topbar.back")}>
          <IconBack />
          {t("topbar.back")}
        </button>
      )}
      <div className="ap-seg" role="group" aria-label="cadence">
        <button className={cadence === "turn" ? "active" : ""} onClick={() => onMode("turn", acceptance)}>
          {t("topbar.turn")}
        </button>
        <button
          className={cadence === "instant" ? "active" : ""}
          disabled={noAgent}
          title={noAgentTitle}
          onClick={() => onMode("instant", acceptance)}
        >
          {t("topbar.instant")}
        </button>
      </div>
      <SettingsMenu acceptance={acceptance} autoResolve={props.autoResolve} onAcceptance={(a) => onMode(cadence, a)} onAutoResolve={props.onAutoResolve} onReplayTutorial={props.onReplayTutorial} forceOpen={props.forceSettingsOpen} />
      <div className="ap-seg" role="group" aria-label="panes">
        {([1, 2, 3] as const).map((n) => (
          <button
            key={n}
            className={panes === n ? "active" : ""}
            title={t(n > 1 ? "topbar.panesPlural" : "topbar.panes", { n })}
            onClick={() => props.onPanes(n)}
          >
            <PaneIcon n={n} />
          </button>
        ))}
      </div>
      <div className="ap-seg" role="group" aria-label="zoom">
        <button title={t("topbar.zoomOut")} aria-label={t("topbar.zoomOut")} onClick={() => props.onZoom(-1)}>
          <IconZoomOut />
        </button>
        <button className="ap-zoom-val" title={t("topbar.resetZoom")} aria-label={t("topbar.resetZoom")} onClick={() => props.onZoom(0)}>
          {Math.round(props.zoom * 100)}%
        </button>
        <button title={t("topbar.zoomIn")} aria-label={t("topbar.zoomIn")} onClick={() => props.onZoom(1)}>
          <IconZoomIn />
        </button>
      </div>
      <div className="ap-spacer" />
      {/* Cross-document back/forward (following in-doc links). Rarely used, so it only
          appears once a link history exists, sits centered, and disables at the ends. */}
      {props.nav && (props.nav.canBack || props.nav.canForward) && (
        <div className="ap-seg ap-nav-seg" role="group" aria-label="navigation">
          <button title={t("topbar.prevDoc")} aria-label={t("topbar.prevDoc")} disabled={!props.nav.canBack} onClick={props.nav.onBack}>
            <IconBack />
          </button>
          <button title={t("topbar.nextDoc")} aria-label={t("topbar.nextDoc")} disabled={!props.nav.canForward} onClick={props.nav.onForward}>
            <IconForward />
          </button>
        </div>
      )}
      <div className="ap-spacer" />
      <div className="ap-iconrow" role="group" aria-label="document tools">
        <button className="ap-iconbtn" onClick={props.onToggleFind} title={`${t("topbar.find")}  (${MOD_KEY}+F)`} aria-label={t("topbar.find")}>
          <IconFind />
        </button>
        <button
          className="ap-iconbtn"
          onClick={props.onAddComment}
          disabled={props.locked || (props.hasSelection && props.commentBlockTip !== null)}
          title={
            props.hasSelection && props.commentBlockTip
              ? props.commentBlockTip
              : props.hasSelection
                ? t("topbar.addCommentTitle")
                : t("topbar.addDocCommentTitle")
          }
          aria-label={props.hasSelection ? t("topbar.addComment") : t("topbar.addDocComment")}
        >
          <IconComment />
        </button>
      </div>
      <div className="ap-iconrow" role="group" aria-label="save and turn">
        <button className="ap-iconbtn" onClick={props.onSave} title={props.dirty ? t("topbar.saveUnsaved") : t("topbar.save")} aria-label={t("topbar.save")}>
          <IconSave />
          {props.dirty && <span className="ap-dirty" aria-hidden="true" />}
        </button>
        {cadence === "turn" && (
          <button
            className="ap-iconbtn"
            onClick={props.onFinishTurn}
            disabled={props.locked || noAgent}
            title={noAgentTitle ?? t("topbar.finishTurnTitle")}
            aria-label={t("topbar.finishTurn")}
          >
            <IconFinishTurn />
          </button>
        )}
      </div>
      {profile?.presenceAware && (
        <AgentIndicator
          location={profile.agentLocation}
          model={profile.agentModel}
          quota={profile.agentQuota}
          byoKey={profile.agentByoKey}
          policy={profile.agentPolicy}
          onSetPolicy={profile.onSetAgentPolicy}
        />
      )}
      {profile && <ProfileMenu user={profile.user} actions={profile.actions} />}
    </header>
  );
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function FindReplaceBar({
  doc,
  seed,
  onApply,
  onClose,
  onNavigate,
  onQuery,
}: {
  doc: ParsedDocument;
  seed?: string;
  onApply: (next: ParsedDocument, action?: { type: string; payload?: unknown }) => void;
  onClose: () => void;
  onNavigate: (m: FindMatch) => void;
  onQuery: (opts: { query: string; ci: boolean; inPreview: boolean; inEditor: boolean; inComments: boolean }) => void;
}): JSX.Element {
  const t = useT();
  const [find, setFind] = useState(seed ?? ""); // pre-filled from the preview "Find text" menu item
  const [replace, setReplace] = useState("");
  const [replaceMode, setReplaceMode] = useState(false);
  const [inPreview, setInPreview] = useState(true); // search the rendered preview pane
  const [inEditor, setInEditor] = useState(false); // search the source pane (mutually exclusive with preview)
  const [inComments, setInComments] = useState(false);
  const [ci, setCi] = useState(false);
  const [idx, setIdx] = useState(0);
  const navAfterReplace = useRef(false);

  // Report the query + scope up so the preview/rail can highlight matches; clear on unmount.
  useEffect(() => {
    onQuery({ query: find, ci, inPreview, inEditor, inComments });
  }, [find, ci, inPreview, inEditor, inComments, onQuery]);
  useEffect(() => () => onQuery({ query: "", ci: false, inPreview: true, inEditor: false, inComments: false }), [onQuery]);

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
    if (inPreview || inEditor) scan(doc.body, (from, to) => ({ scope: "body", from, to }));
    if (inComments) for (const c of doc.comments) scan(c.text, (from, to) => ({ scope: "comment", id: c.id, from, to }));
    return out;
  }, [find, doc, inPreview, inEditor, inComments, ci]);

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
    const body = inPreview || inEditor ? doc.body.replace(new RegExp(escapeRegExp(find), flags), replace) : doc.body;
    const comments = inComments ? doc.comments.map((c) => ({ ...c, text: c.text.replace(new RegExp(escapeRegExp(find), flags), replace) })) : doc.comments;
    onApply({ body, comments }, { type: "document_edited", payload: { findReplace: "all" } });
  };

  return (
    <div className="ap-find">
      <label className="ap-find-mode" title={t("find.toggleReplace")}>
        <input type="checkbox" checked={replaceMode} onChange={(e) => setReplaceMode(e.target.checked)} /> {t("find.replace")}
      </label>
      <input
        id="ap-find-input"
        placeholder={t("find.findPlaceholder")}
        value={find}
        onChange={(e) => {
          setFind(e.target.value);
          setIdx(0);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? idx - 1 : idx + 1);
          }
        }}
        autoFocus
      />
      {replaceMode && <input placeholder={t("find.replacePlaceholder")} value={replace} onChange={(e) => setReplace(e.target.value)} />}
      <span className="ap-find-scope">
        <label title={t("find.searchPreview")}>
          <input
            type="checkbox"
            checked={inPreview}
            onChange={(e) => {
              setInPreview(e.target.checked);
              if (e.target.checked) setInEditor(false); // preview ⊕ editor
            }}
          />{" "}
          {t("find.preview")}
        </label>
        <label title={t("find.searchEditor")}>
          <input
            type="checkbox"
            checked={inEditor}
            onChange={(e) => {
              setInEditor(e.target.checked);
              if (e.target.checked) setInPreview(false); // preview ⊕ editor
            }}
          />{" "}
          {t("find.editor")}
        </label>
        <label>
          <input type="checkbox" checked={inComments} onChange={(e) => setInComments(e.target.checked)} /> {t("find.comments")}
        </label>
        <label title={t("find.caseInsensitive")}>
          <input type="checkbox" checked={ci} onChange={(e) => setCi(e.target.checked)} /> Aa
        </label>
      </span>
      <span className="ap-muted">{n ? `${Math.min(idx + 1, n)}/${n}` : "0/0"}</span>
      {replaceMode ? (
        <>
          <button onClick={() => replaceCurrent(-1)} disabled={!n}>
            {t("find.replacePrev")}
          </button>
          <button onClick={() => replaceCurrent(1)} disabled={!n}>
            {t("find.replaceNext")}
          </button>
          <button onClick={replaceAll} disabled={!n}>
            {t("find.replaceAll")}
          </button>
        </>
      ) : (
        <>
          <button onClick={() => go(idx - 1)} disabled={!n}>
            {t("find.findPrev")}
          </button>
          <button onClick={() => go(idx + 1)} disabled={!n}>
            {t("find.findNext")}
          </button>
        </>
      )}
      <button className="ap-link" onClick={onClose}>
        {t("find.close")}
      </button>
    </div>
  );
}

/** Inline diff rendered in the PREVIEW pane: changed blocks shown in place as
 *  rendered Markdown, with a per-hunk accept/reject toggle. This is the complete
 *  review surface in 1-pane mode (where the source pane isn't visible). */
function DiffPreview({ segs, accepted, focused, onToggle }: { segs: DiffSegment[]; accepted: boolean[]; focused: number; onToggle: (i: number, v: boolean) => void }): JSX.Element {
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
          <div key={i} data-hunk={idx} className={`ap-ihunk${on ? " accepted" : " rejected"}${focused === idx ? " focused" : ""}`}>
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
function DiffSource({ segs, accepted, focused, onToggle }: { segs: DiffSegment[]; accepted: boolean[]; focused: number; onToggle: (i: number, v: boolean) => void }): JSX.Element {
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
          <div key={i} data-hunk={idx} className={`ap-hunk${on ? " accepted" : " rejected"}${focused === idx ? " focused" : ""}`}>
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
  const t = useT();
  const root = thread.root;
  const isDoc = root.anchor === "doc";
  // Doc comments carry no anchor, so skip the anchor/quote line entirely.
  const quote = isDoc ? null : orphaned ? t("thread.orphaned") : (anchoredText(body, root.id) ?? t("thread.anchorMissing"));
  // The persisted answer (latest reply carrying a selection) — keeps the choice chips
  // checked across reloads instead of resetting the picker to empty.
  const answeredSelection = useMemo<string[] | null>(() => {
    for (let i = thread.replies.length - 1; i >= 0; i--) {
      const sel = thread.replies[i]!.selected;
      if (sel !== undefined) return sel;
    }
    return null;
  }, [thread.replies]);
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
        <span className="ap-meta-who">
          {isReply ? "↳ " : ""}
          {c.author} · {c.date.slice(0, 16).replace("T", " ")}
        </span>
        {/* ⋯ menu sits on the meta line so it lines up with the timestamp. */}
        {!disabled && editingId !== c.id && (
          <div className="ap-cmenu">
            <button
              className="ap-cmenu-btn"
              title={t("thread.more")}
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
                  {t("thread.modify")}
                </button>
                <button
                  className="ap-danger"
                  onClick={() => {
                    props.onDelete(c.id);
                    setMenuOpenId(null);
                  }}
                >
                  {t("thread.delete")}
                </button>
              </div>
            )}
          </div>
        )}
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
              {t("thread.save")}
            </button>
            <button className="ap-link" onClick={() => setEditingId(null)}>
              {t("thread.cancel")}
            </button>
          </div>
        </div>
      ) : (
        c.text && <div className="ap-text">{c.text}</div>
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
      {root.question && <QuestionChips question={root.question} disabled={disabled} answered={answeredSelection} onAnswer={props.onAnswer} />}
      {thread.replies.map((r) => renderComment(r, true))}

      {/* Resolve is per thread; Reply opens a box with explicit Comment / Cancel. */}
      <div className="ap-row ap-thread-actions">
        <button className="ap-link" disabled={disabled} onClick={() => props.onResolve(!root.resolved)}>
          {root.resolved ? t("rail.reopenThread") : t("rail.resolveThread")}
        </button>
        {!replying && (
          <button className="ap-link" disabled={disabled} onClick={() => setReplying(true)}>
            {t("rail.reply")}
          </button>
        )}
      </div>
      {replying && (
        <div className="ap-reply-box">
          <textarea
            className="ap-grow"
            placeholder={t("thread.replyPlaceholder")}
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
              {t("thread.comment")}
            </button>
            <button
              className="ap-link"
              onClick={() => {
                setReplyText("");
                setReplying(false);
              }}
            >
              {t("thread.cancel")}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}

