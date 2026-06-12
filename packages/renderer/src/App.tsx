// SPDX-License-Identifier: AGPL-3.0-or-later

import { isDocComment, isSpanComment, LogEventType, parse, serialize, type Comment, type ParsedDocument, type Question } from "@inplan/core";
import { Fragment, type MouseEvent as ReactMouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { hostApi, realHostApi, setApiOverride, type Acceptance, type Api, type Cadence, type ProfileState, type SidePanelSpec } from "./api";
import { TURN_MODE, resolveMode, type ModeDescriptor } from "./mode";
import {
  setAnswer,
  addDocComment,
  addReply,
  addSpanComment,
  autoResolveSuggested,
  buildThreads,
  deleteComment,
  editCommentText,
  linkSelectionToDoc,
  moveSelectionToDoc,
  setResolved,
  spanCommentBlocker,
  spanSource,
  suggestsResolve,
  type SourceSpan,
  type Thread,
} from "./docOps";
import { reconcileComments } from "./commentStore";
import { anchorIdsIn, remapComments, rewriteAnchors, threadsFor, type ClipboardPayload } from "./clipboard";
import { moveDocTitle, slugifyFilename } from "./newDoc";
import { NewDocModal } from "./NewDocModal";
import { renderMarkdown } from "./markdown";
import { isInternalDocLink, resolveDocPath } from "./links";
import { ComposerPopover } from "./ComposerPopover";
import { Switch } from "./Switch";
import { ContextMenu } from "./ContextMenu";
import { MOD_KEY } from "./platform";
import { QuestionChips } from "./QuestionChips";
import { SourceEditor, type SourceEditorHandle } from "./SourceEditor";
import { StatusBar } from "./StatusBar";
import { ProfileMenu } from "./ProfileMenu";
import { AgentIndicator } from "./AgentIndicator";
import { IconBack, IconForward, IconUp, IconDown, IconZoomOut, IconZoomIn, IconFind, IconComment, IconSave, IconFinishTurn, IconRevealArchive, IconComplete, IconReopen, IconPencil } from "./Icons";
import { RelativeTime } from "./RelativeTime";
import { AuthorChip } from "./Avatar";
import { QuitDialog } from "./QuitDialog";
import { EditorErrorBoundary } from "./EditorErrorBoundary";
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

/**
 * Cloud sign-in modal overlay (desktop). A dimmed backdrop over the editor with the host-supplied
 * /cli-auth page in an iframe; clicking the backdrop (or pressing Esc) dismisses it. Email/password
 * completes in the frame; OAuth providers open in the system browser (the page's window.open is
 * routed there by the host), and the page redirects to the host's loopback when done.
 */
function CloudSignInOverlay({ url, onDismiss }: { url: string; onDismiss: () => void }): JSX.Element {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDismiss]);
  return (
    <div className="ap-signin-backdrop" onMouseDown={onDismiss} role="presentation">
      <div className="ap-signin-panel" onMouseDown={(e) => e.stopPropagation()}>
        <iframe className="ap-signin-frame" src={url} title="Sign in to inplan.ai" />
      </div>
    </div>
  );
}

export function App(props: EditorProps = {}): JSX.Element {
  const t = useT();
  const [loaded, setLoaded] = useState(false);
  const [doc, setDoc] = useState<ParsedDocument>(EMPTY);
  const [cadence, setCadence] = useState<Cadence>("turn");
  // Available modes: the built-in TURN plus any a plugin advertises via extraModes. The active
  // mode's descriptor drives lock/autosave/apply/Finish-turn behaviour.
  const modes = useMemo(() => [TURN_MODE, ...(hostApi().extraModes ?? [])], []);
  const mode = resolveMode(cadence, modes);
  const [acceptance, setAcceptance] = useState<Acceptance>("review"); // first-run default: agent parks edits for review
  const [autoResolve, setAutoResolve] = useState(false); // first-run default: leave threads for the human to resolve
  const [agentMode, setAgentMode] = useState<"planning" | "implementation">("planning"); // default: planning loop
  const [telemetry, setTelemetry] = useState(false); // opt-in anonymous usage analytics — default OFF
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
  const [signInUrl, setSignInUrl] = useState<string | null>(null); // cloud sign-in overlay target (desktop)
  // The human's resolved identity authors their comments ("Name <email>"); falls back
  // to "You" until a profile resolves (cloud/git/manual). A ref keeps callbacks fresh.
  const profile = useProfile();
  const userAuthor = profile?.user ? (profile.user.email ? `${profile.user.name} <${profile.user.email}>` : profile.user.name) : USER_AUTHOR;
  const userAuthorRef = useRef(userAuthor);
  userAuthorRef.current = userAuthor;
  const [updating, setUpdating] = useState<"idle" | "running" | "done" | "failed">("idle");
  const [showResolvedOrphaned, setShowResolvedOrphaned] = useState(false);
  const [selectionText, setSelectionText] = useState("");
  const [composer, setComposer] = useState<{ target: string | null; pos: { x: number; y: number }; span?: SourceSpan | null } | null>(null);
  const [newDocReq, setNewDocReq] = useState<{ mode: "create" | "move"; selected: string; span: SourceSpan | null; existing?: string } | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; hasSel: boolean; hasRawSel: boolean; block: BlockReason | null } | null>(null);
  const [findSeed, setFindSeed] = useState(""); // pre-fills the find box (e.g. from the preview "Find text" menu item)
  const [focused, setFocused] = useState<string | null>(null);
  const [activePreviewLine, setActivePreviewLine] = useState<number | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [reviewOpen, setReviewOpen] = useState(false); // is the review panel visible (vs. parked behind a banner)
  const [findOpen, setFindOpen] = useState(false);
  const [findOpts, setFindOpts] = useState<{ query: string; ci: boolean; inPreview: boolean; inEditor: boolean; inComments: boolean }>({ query: "", ci: false, inPreview: true, inEditor: false, inComments: false });
  const [openPanel, setOpenPanel] = useState<string | null>(null); // id of the open host-injected side panel (e.g. the cloud TOC), or null
  const panelHideTimer = useRef<ReturnType<typeof setTimeout> | null>(null); // auto-hide the side panel shortly after the cursor leaves it
  const [closingPanel, setClosingPanel] = useState<SidePanelSpec | null>(null); // the panel mid fold-out (kept mounted for the exit animation)
  const lastOpenPanelRef = useRef<SidePanelSpec | null>(null);

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
  // Per-doc undo/redo, kept across in-window navigation: leaving a doc stashes its stacks here,
  // returning restores them — so back/forward (or re-following a link) doesn't lose history.
  const historyByDoc = useRef<Map<string, { undo: ParsedDocument[]; redo: ParsedDocument[] }>>(new Map());
  const savedRef = useRef<string>(""); // last canonical-saved serialized content (for the dirty dot)
  // Last content written to ANY store (canonical or backup). State, not a ref, so the Save button
  // and status bar re-render when a save resolves — a turn-mode Save writes a backup, which clears
  // the unsaved indicator even though the canonical file (the `dirty` baseline) hasn't changed.
  const [checkpoint, setCheckpoint] = useState("");
  const skipPreviewScroll = useRef(false); // set when the active line came from a click in the preview itself
  const autoResolvedRef = useRef<Set<string>>(new Set()); // thread ids already auto-resolved (so undo can't re-trigger)
  const saveNowRef = useRef<() => void>(() => {}); // latest saveNow (the ⌘/Ctrl+S handler calls via this)

  // --- persisted layout ---
  useEffect(() => {
    try {
      const s = JSON.parse(localStorage.getItem("ap-layout") ?? "{}");
      if (s.panes === 1 || s.panes === 2 || s.panes === 3) setPanes(s.panes);
      if (s.rightTab === "comments" || s.rightTab === "source") setRightTab(s.rightTab);
      if (typeof s.zoom === "number") setZoom(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, s.zoom)));
      if (typeof s.showResolvedOrphaned === "boolean") setShowResolvedOrphaned(s.showResolvedOrphaned);
      if (typeof s.cadence === "string" && modes.some((m) => m.id === s.cadence)) setCadence(s.cadence);
      if (typeof s.srcW === "number") setSrcW(Math.min(900, Math.max(220, s.srcW)));
      if (typeof s.cmtW === "number") setCmtW(Math.min(900, Math.max(220, s.cmtW)));
    } catch {
      /* ignore */
    }
  }, []);
  useEffect(() => {
    localStorage.setItem("ap-layout", JSON.stringify({ panes, rightTab, zoom, showResolvedOrphaned, cadence, srcW, cmtW }));
  }, [panes, rightTab, zoom, showResolvedOrphaned, cadence, srcW, cmtW]);

  // Global, cross-session user settings (they shape agent behavior), loaded from
  // ~/.inplan/settings.json on launch — not localStorage. Acceptance lives here too now, so the
  // editor's toggle and the CLI gate read the same source of truth (default "review").
  useEffect(() => {
    void hostApi().getSettings().then((s) => {
      setAutoResolve(s.autoResolve);
      setAgentMode(s.agentMode ?? "planning");
      setTelemetry(s.telemetry === true);
      setAcceptance(s.acceptance === "auto" ? "auto" : "review");
    });
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

    const commentStore = hostApi().commentStore ?? null;

    hostApi()
      .load()
      .then(({ content, path }) => {
        docPathRef.current = path;
        const parsed = parse(content);
        // With an external comment store (plugin) comments are owned by the store, not the
        // serialized body — source them from the store; its observer keeps them in sync.
        const d = commentStore ? { ...parsed, comments: commentStore.list() } : parsed;
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
        const prevDoc = docRef.current;
        const parsed = parse(content);
        // Store-backed (plugin): comments are owned by the external store, not the rewritten
        // body — keep them from the store so an agent/body refresh can't blank/stale the rail.
        const next = commentStore ? { ...parsed, comments: commentStore.list() } : parsed;
        setAgentThinking(false);
        setDoc(next);
        savedRef.current = serialize(next);
        setDirty(false);
        // Collab: the binding owns the SOURCE pane (the controlled value is ignored once a binding is
        // present), so an external/agent body change must also be pushed to the binding — otherwise it
        // updates only the preview and the source stays stale (and a server edit that didn't broadcast,
        // e.g. a version-history restore, reverts on reload). Idempotent: a no-op when a provider
        // broadcast already delivered the body (normal auto-accept turns). File-backed editors have no
        // binding and keep using the controlled value.
        syncExternalDoc(next, prevDoc.comments, prevDoc.body);
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
        // Undo/redo is per-doc: stash the leaving doc's stacks so returning restores them, and load
        // the destination's own (empty on first visit). Per-doc still holds — an undo can never pull
        // another doc's content — but the history now survives navigation instead of being dropped.
        if (docPathRef.current) historyByDoc.current.set(docPathRef.current, { undo: history.current, redo: future.current });
        docPathRef.current = path;
        const parsed = parse(content);
        const d = commentStore ? { ...parsed, comments: commentStore.list() } : parsed;
        setDoc(d);
        savedRef.current = serialize(d);
        setDirty(false);
        const restored = historyByDoc.current.get(path);
        history.current = restored?.undo ?? [];
        future.current = restored?.redo ?? [];
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
      // Desktop only: show / tear down the cloud sign-in modal overlay on the host's request.
      hostApi().cloudSignIn?.onOpen((url) => setSignInUrl(url)),
      hostApi().cloudSignIn?.onClose(() => setSignInUrl(null)),
      // Comment store (plugin): adopt the external store's comments whenever it (or this editor)
      // changes them. Body stays driven by the editor/binding; only `comments` is synced.
      commentStore?.observe(() => setDoc((d) => ({ ...d, comments: commentStore.list() }))),
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

  // Push a doc state to the collaborative owners — comments → the store, body → the binding (a
  // shared text buffer) — so undo/redo (and programmatic edits) reach the shared doc, not just React
  // state the binding would overwrite. `prevComments`/`prevBody` are what's being replaced (the
  // delta base). Returns true ONLY when the change was fully handed off to an external owner; the
  // caller then clears dirty + skips save(). If the BODY changed but no binding can write it
  // (no `setText`), we return false so the caller falls back to the file-backed save/dirty path —
  // never silently dropping the edit. No-op + false for the file-backed editor (no store/binding).
  const syncExternalDoc = useCallback((d: ParsedDocument, prevComments: Comment[], prevBody: string) => {
    const store = hostApi().commentStore;
    const binding = hostApi().binding;
    if (!store && !binding) return false;
    const bodyChanged = d.body !== prevBody;
    if (store) {
      reconcileComments(store, prevComments, d.comments); // unified: comments owned by the store
      if (!bodyChanged) return true;
      if (!binding?.setText) return false; // body changed but no writer → caller handles it
      binding.setText(d.body); // unified: the binding owns the bare body
      return true;
    }
    // Legacy collab: the binding owns the whole serialized doc (body + comment block).
    if (!binding?.setText) return false;
    binding.setText(serialize(d));
    return true;
  }, []);
  const undo = useCallback(() => {
    const prev = history.current.pop();
    if (!prev) {
      setStatus(t("msg.nothingUndo"));
      return;
    }
    const cur = docRef.current;
    future.current.push(cur);
    setDoc(prev);
    if (syncExternalDoc(prev, cur.comments, cur.body)) setDirty(false);
    else setDirty(serialize(prev) !== savedRef.current);
    setStatus(t("msg.undid"));
  }, [syncExternalDoc]);
  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) {
      setStatus(t("msg.nothingRedo"));
      return;
    }
    const cur = docRef.current;
    history.current.push(cur);
    setDoc(next);
    if (syncExternalDoc(next, cur.comments, cur.body)) setDirty(false);
    else setDirty(serialize(next) !== savedRef.current);
    setStatus(t("msg.redid"));
  }, [syncExternalDoc]);

  // Review undo/redo are defined later (with the review state); the keyboard handler reaches them
  // through refs so it doesn't depend on their declaration order.
  const reviewUndoRef = useRef<() => void>(() => {});
  const reviewRedoRef = useRef<() => void>(() => {});

  // --- keyboard ergonomics ---
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === "z" || e.key === "Z")) {
        // While the source editor OR the inline proposal-edit textarea is focused, let the native
        // field handle typing undo.
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest(".ap-source") || active?.closest(".ap-ihunk-edit-ta")) return;
        e.preventDefault();
        // While a review is open the doc isn't mutated yet — undo/redo step through the review's own
        // timeline (accept/reject toggles + hunk edits), not the document history.
        if (proposal && reviewOpen) {
          if (e.shiftKey) reviewRedoRef.current();
          else reviewUndoRef.current();
        } else if (e.shiftKey) redo();
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
      } else if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === "s" || e.key === "S")) {
        // ⌘/Ctrl+S — save (canonical in Instant, a checkpoint backup in Turn), from anywhere.
        e.preventDefault();
        saveNowRef.current();
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

  const editingLocked = mode.locksEditor && agentThinking;

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
    const delay = mode.autosaveDelayMs;
    autosaveTimer.current = setTimeout(() => {
      const content = serialize(docRef.current);
      // Mark the content checkpointed only AFTER the save resolves — if it fails (disk /
      // IPC error) the status bar must keep showing the work as unsaved, not safe.
      void hostApi().save(content, { kind: mode.autosaveKind, cadence }).then(() => setCheckpoint(content));
      if (mode.autosaveKind === "canonical") {
        // A canonical autosave is a real save (it wakes the agent) — clear dirty.
        savedRef.current = content;
        setDirty(false);
        setStatus(t("msg.autosaving"));
      } else {
        // A backup is silent and does NOT end the turn — keep showing work as in-progress.
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
      const prevDoc = docRef.current;
      const commentOnly = next.body === prevDoc.body; // body unchanged ⇒ a comment-thread change
      const prevComments = prevDoc.comments;
      setDoc(next);
      if (action) void hostApi().logAction(action.type, action.payload);
      // Collaborative: push to the external owners — comments → store, body → binding. A SPAN
      // comment changes the body (its `[text](#cmt-id)` anchor link) AND the comments, so it must
      // hit both owners; the controlled editor value is ignored once a binding owns the body
      // (SourceEditor), and persistence is the shared doc's (no save() second-writer — #71).
      if (syncExternalDoc(next, prevComments, prevDoc.body)) {
        setDirty(false);
      } else if (commentOnly) {
        // File-backed single-writer. Comment-thread changes are "always applied" — persist them
        // immediately (silent in Turn/Review; canonical in Instant) so they survive reloads/proposals.
        const s = serialize(next);
        savedRef.current = s;
        setDirty(false);
        // A canonical/apply save also advances the checkpoint (canonical IS a store), so keep them
        // in sync — otherwise checkpoint goes stale and the Save dot can mis-clear later.
        void hostApi().save(s, { kind: mode.applyKind, cadence }).then(() => setCheckpoint(s));
      } else {
        setDirty(serialize(next) !== savedRef.current); // body edit → the normal autosave flow
      }
    },
    [cadence, syncExternalDoc],
  );

  // --- clipboard: carry span-comment threads through copy/cut/paste (see clipboard.ts) ---
  // The source editor's selection offsets are body offsets (CodeMirror's content is the bare
  // body — file-backed, or the collaboration binding's shared text), so all three route through the
  // same apply() the span-comment flow uses: body change → binding/file, comments → store.
  const commentsForCopy = useCallback((text: string): Comment[] => {
    const ids = anchorIdsIn(text);
    return ids.length ? threadsFor(ids, docRef.current.comments) : [];
  }, []);
  const onCutComments = useCallback(
    (_text: string, from: number, to: number) => {
      const cur = docRef.current;
      const carried = new Set(threadsFor(anchorIdsIn(cur.body.slice(from, to)), cur.comments).map((c) => c.id));
      const body = cur.body.slice(0, from) + cur.body.slice(to);
      apply({ body, comments: cur.comments.filter((c) => !carried.has(c.id)) }, { type: "comment_deleted", payload: { count: carried.size } });
    },
    [apply],
  );
  const onPasteComments = useCallback(
    (text: string, payload: ClipboardPayload, from: number, to: number) => {
      const cur = docRef.current;
      const taken = new Set(cur.comments.map((c) => c.id));
      const { comments: pasted, idMap } = remapComments(payload.comments, taken);
      const body = cur.body.slice(0, from) + rewriteAnchors(text, idMap) + cur.body.slice(to);
      apply({ body, comments: [...cur.comments, ...pasted] }, { type: "comment_created", payload: { count: pasted.length } });
    },
    [apply],
  );

  // Auto-resolve: when the setting is on, resolve threads the agent suggested (its `may_resolve`
  // on the thread's last comment). Runs on load + when the setting flips on. We remember which
  // threads we've auto-resolved (`autoResolvedRef`) and skip them on later passes, so undoing an
  // auto-resolution doesn't immediately re-resolve it (which would clear the redo stack).
  useEffect(() => {
    if (!autoResolve || !loaded) return;
    const next = autoResolveSuggested(docRef.current, autoResolvedRef.current);
    if (!next) return;
    for (const t of buildThreads(docRef.current.comments)) {
      if (suggestsResolve(t)) autoResolvedRef.current.add(t.root.id);
    }
    apply(next, { type: "comment_resolved", payload: { auto: true } });
  }, [doc, autoResolve, loaded, apply]);

  const onModeChange = useCallback(
    (c: Cadence, a: Acceptance) => {
      setCadence(c);
      setAcceptance(a);
      // Record the mode's gate policy so the (mode-agnostic) CLI honours it.
      const m = resolveMode(c, modes);
      void hostApi().setMode(c, a, { wake: m.wake, locksEditor: m.locksEditor });
    },
    [modes],
  );

  // Global agent-behavior settings: persist the whole object (the host overwrites the
  // file), so always send every field — refs keep the callbacks fresh without re-creating.
  const settingsRef = useRef({ autoResolve, agentMode, telemetry, acceptance });
  settingsRef.current = { autoResolve, agentMode, telemetry, acceptance };
  const onAutoResolve = useCallback((v: boolean) => {
    setAutoResolve(v);
    void hostApi().setSettings({ ...settingsRef.current, autoResolve: v });
  }, []);
  const onAgentMode = useCallback((m: "planning" | "implementation") => {
    setAgentMode(m);
    void hostApi().setSettings({ ...settingsRef.current, agentMode: m });
  }, []);
  const onTelemetry = useCallback((v: boolean) => {
    setTelemetry(v);
    void hostApi().setSettings({ ...settingsRef.current, telemetry: v });
  }, []);
  // Acceptance is a global setting now (so the CLI gate reads the same value on launch) — persist
  // via setSettings, not the per-doc mode_changed that the cadence toggle still uses.
  const onAcceptanceChange = useCallback((a: Acceptance) => {
    setAcceptance(a);
    void hostApi().setSettings({ ...settingsRef.current, acceptance: a });
  }, []);

  const onZoom = useCallback((dir: -1 | 0 | 1) => {
    setZoom((z) => (dir === 0 ? 1 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +(z + dir * 0.1).toFixed(2)))));
  }, []);

  const saveNow = useCallback(() => {
    const content = serialize(docRef.current);
    const kind = mode.autosaveKind;
    // Checkpoint only once the save resolves, so a failed write can't be reported as saved.
    void hostApi().save(content, { kind, cadence }).then(() => setCheckpoint(content));
    if (kind === "canonical") {
      savedRef.current = content;
      setDirty(false);
    }
    setStatus(kind === "canonical" ? "saved" : "checkpoint saved");
  }, [cadence, mode]);
  saveNowRef.current = saveNow; // keep the ⌘/Ctrl+S handler pointed at the current saveNow

  // Question threads whose picker holds an UNSAVED answer (reported by QuestionChips), and which of
  // those we've already nudged this turn — so the Send guard interrupts at most once per question.
  const pendingAnswersRef = useRef<Set<string>>(new Set());
  const nudgedAnswersRef = useRef<Set<string>>(new Set());
  const setQuestionPending = useCallback((id: string, pending: boolean) => {
    if (pending) pendingAnswersRef.current.add(id);
    else pendingAnswersRef.current.delete(id);
  }, []);

  const finishTurn = useCallback(() => {
    // Before sending: if a question still has an unsaved answer, focus it and ask the human to click
    // "Answer" — once per question. Each Send nudges the next un-nudged one and stops; once all are
    // nudged, Send goes through (the human chose to leave them). Cleared on a successful send.
    const next = [...pendingAnswersRef.current].find((id) => !nudgedAnswersRef.current.has(id));
    if (next) {
      nudgedAnswersRef.current.add(next);
      const card = railRef.current?.querySelector(`[data-cmt-card="${next}"]`) as HTMLElement | null;
      card?.scrollIntoView({ block: "center" });
      (card?.querySelector(".ap-chip input, .ap-other") as HTMLElement | null)?.focus();
      setFocused(next);
      setStatus(t("msg.unsavedAnswer"));
      return;
    }
    nudgedAnswersRef.current.clear();
    const content = serialize(docRef.current);
    // Canonical save → advance both baselines (savedRef and the any-store checkpoint).
    void hostApi().save(content, { kind: "canonical", cadence: "turn" }).then(() => setCheckpoint(content));
    savedRef.current = content;
    setDirty(false);
    setAgentThinking(true);
    hostApi().telemetry?.("turn_finished"); // activation funnel (opt-in, gated by the host)
    setStatus(t("msg.turnFinished"));
  }, [setQuestionPending]);

  const [quitOpen, setQuitOpen] = useState(false);
  const [forceSettingsOpen, setForceSettingsOpen] = useState(false); // onboarding opens the ⚙ menu on its settings step
  // Confirmed quit: the host saves (if asked), signals the agent (if asked), then leaves.
  const confirmQuit = useCallback((opts: { save: boolean; startBuild: boolean }) => {
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
      if (props.onboarding) real.exit?.quit("", { save: false, startBuild: false });
      else setQuitOpen(true);
    });
  }, [props.onboarding]);

  // --- comment actions ---
  const addComment = useCallback(
    (text: string, target: string | null, span?: SourceSpan | null, question?: Question) => {
      if (target) {
        // Guard against an un-anchorable or OVERLAPPING span (nested links would
        // corrupt the doc) even if the UI's disabled state was bypassed. `span` (the
        // selection's source line range) pins the anchor to the clicked spot.
        const blocker = spanCommentBlocker(docRef.current.body, target, span ?? undefined);
        if (blocker) {
          setStatus(blocker === "overlap" ? t("topbar.cantOverlap") : t("msg.cantAnchor"));
          return;
        }
        const res = addSpanComment(docRef.current, target, { text, author: userAuthorRef.current, question }, span ?? undefined);
        if (!res) {
          setStatus(t("msg.cantAnchor"));
          return;
        }
        apply(res.doc, { type: "comment_created", payload: { id: res.id } });
        hostApi().telemetry?.("comment_created", { kind: "span" }); // activation funnel; never the text
        setFocused(res.id);
      } else {
        const res = addDocComment(docRef.current, { text, author: userAuthorRef.current, question });
        apply(res.doc, { type: "comment_created", payload: { id: res.id, anchor: "doc" } });
        hostApi().telemetry?.("comment_created", { kind: "doc" });
        setFocused(res.id);
      }
    },
    [apply],
  );

  const reportFind = useCallback((o: { query: string; ci: boolean; inPreview: boolean; inEditor: boolean; inComments: boolean }) => setFindOpts(o), []);

  // The source line range (0-based, inclusive) the preview selection sits in, read from the
  // enclosing blocks' `data-line` attributes. Passed to addSpanComment so the anchor maps to
  // the clicked spot — not a same-looking phrase elsewhere in the doc (markup-aware, scoped).
  const selectionSourceSpan = useCallback((range: Range | null): SourceSpan | null => {
    if (!range) return null;
    const blockOf = (n: Node | null): HTMLElement | null => {
      const el = n && n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element | null);
      return (el?.closest?.("[data-line]") as HTMLElement | null) ?? null;
    };
    const startBlock = blockOf(range.startContainer);
    if (!startBlock) return null;
    const startLine = Number(startBlock.getAttribute("data-line"));
    // A source line must be a non-negative integer; anything else (negative, fractional,
    // NaN) is a bogus attribute we won't anchor to.
    if (!Number.isInteger(startLine) || startLine < 0) return null;
    const endBlock = blockOf(range.endContainer) ?? startBlock;
    // The selection's block(s) can span several source lines (a multi-line paragraph), so
    // extend to just before the NEXT preview block (or the document's end).
    const blocks = Array.from(previewRef.current?.querySelectorAll("[data-line]") ?? []);
    const endIdx = blocks.indexOf(endBlock);
    const nextLine = endIdx >= 0 && endIdx + 1 < blocks.length ? Number(blocks[endIdx + 1]!.getAttribute("data-line")) : NaN;
    const endLine = Number.isFinite(nextLine) ? Math.max(startLine, nextLine - 1) : docRef.current.body.split("\n").length - 1;
    return { startLine, endLine };
  }, []);

  const openComposer = useCallback(() => {
    const sel = window.getSelection();
    const txt = sel?.toString().trim() ?? "";
    if (txt && sel && sel.rangeCount > 0) {
      const range = sel.getRangeAt(0);
      commentRangeRef.current = range.cloneRange(); // keep the span highlighted while composing (item 4)
      const r = range.getBoundingClientRect();
      setComposer({ target: txt, span: selectionSourceSpan(range), pos: { x: Math.max(8, Math.min(r.left, window.innerWidth - 360)), y: Math.max(48, Math.min(r.bottom + 6, window.innerHeight - 220)) } });
    } else {
      commentRangeRef.current = null;
      previewRef.current?.scrollTo({ top: 0 });
      setComposer({ target: null, pos: { x: 24, y: 56 } });
    }
  }, [selectionSourceSpan]);

  // Open the composer from the selection captured at right-click time (not a live
  // re-read) — clicking a menu item can collapse the page selection in some browsers,
  // so the right-click handler stashes the text + range and we use those here.
  const openComposerFromCapture = useCallback(() => {
    const target = ctxSelTextRef.current;
    if (target && commentRangeRef.current) {
      const r = commentRangeRef.current.getBoundingClientRect();
      setComposer({ target, span: selectionSourceSpan(commentRangeRef.current), pos: { x: Math.max(8, Math.min(r.left, window.innerWidth - 360)), y: Math.max(48, Math.min(r.bottom + 6, window.innerHeight - 220)) } });
    } else {
      commentRangeRef.current = null;
      previewRef.current?.scrollTo({ top: 0 });
      setComposer({ target: null, pos: { x: 24, y: 56 } });
    }
  }, [selectionSourceSpan]);

  // Open the Create Doc / Move Text to New Doc modal from the right-click selection (captured
  // text + range, like openComposerFromCapture — a menu click can collapse the live selection).
  const openNewDoc = useCallback(
    (mode: "create" | "move") => {
      const selected = ctxSelTextRef.current;
      if (!selected) return;
      setNewDocReq({ mode, selected, span: selectionSourceSpan(commentRangeRef.current) });
    },
    [selectionSourceSpan],
  );

  // Confirm the modal: the host creates the file (it owns where + returns the relative link), then
  // we rewrite the selection — Create links the text in place; Move replaces it with [title](link)
  // and the body moves to the new doc.
  const createNewDoc = useCallback(
    async (title: string, path: string, opts: { append: boolean; draftPrompt?: string }) => {
      const req = newDocReq;
      const api = hostApi();
      if (!req || !api.newDoc) {
        setNewDocReq(null);
        return;
      }
      // Resolve the link target: create a NEW file, or — when a prior submit found the path already
      // on disk (req.existing) — link/append to that existing doc instead of silently failing.
      let linkTarget: string;
      if (!req.existing) {
        // First submit: build the new doc's content (confirming the move/link is even possible, so a
        // failed splice can't orphan a file) and try to create it.
        let content: string;
        if (req.mode === "move") {
          const pre = moveSelectionToDoc(docRef.current, req.selected, req.span ?? undefined, title, path);
          if (!pre) {
            setStatus(t("newdoc.cantMove")); // unanchorable, crosses formatting, or a comment straddles the edge
            return;
          }
          content = serialize({ body: `${pre.movedBody}\n`, comments: pre.movedComments });
        } else {
          if (spanSource(docRef.current.body, req.selected, req.span ?? undefined) === null) {
            setStatus(t("msg.cantAnchor"));
            return;
          }
          content = `# ${title}\n`;
        }
        // A draft prompt (create mode, host-offered) asks the host to agent-draft the new doc from
        // the prompt instead of just the title; the selection still links to it. Pass the 3rd arg
        // only when drafting, so the plain create call stays a 2-arg call.
        const draftOpts = req.mode === "create" && opts.draftPrompt ? { draftPrompt: opts.draftPrompt } : null;
        const res = draftOpts ? await api.newDoc.create(path, content, draftOpts) : await api.newDoc.create(path, content);
        if (!res) {
          setStatus(t("newdoc.failed"));
          return; // keep the modal open so the user can retry / pick another path
        }
        if (res.status === "exists") {
          // Don't clobber it — surface the link/append options and wait for the user to re-confirm.
          setNewDocReq({ ...req, existing: res.linkTarget });
          setStatus(t("newdoc.exists"));
          return;
        }
        linkTarget = res.linkTarget;
      } else {
        // Confirm against the existing file: Move + Append carries the blocks into it; otherwise we
        // just link (Create links in place; Move-without-Append drops the local blocks).
        linkTarget = req.existing;
        if (req.mode === "move" && opts.append) {
          const pre = moveSelectionToDoc(docRef.current, req.selected, req.span ?? undefined, title, linkTarget);
          if (!pre) {
            setStatus(t("newdoc.cantMove"));
            return;
          }
          const res = await api.newDoc.append?.(path, pre.movedBody, pre.movedComments);
          if (!res) {
            setStatus(t("newdoc.failed"));
            return;
          }
          linkTarget = res.linkTarget;
        }
      }
      // Re-run AFTER the await against the CURRENT doc — the agent may have rewritten it while
      // create()/append() was in flight. Splice against the fresh state so we never clobber a newer
      // version; if it no longer maps cleanly, abort (the file exists, but a stale overwrite is worse).
      let next: ParsedDocument | null;
      if (req.mode === "move") {
        next = moveSelectionToDoc(docRef.current, req.selected, req.span ?? undefined, title, linkTarget)?.remaining ?? null;
      } else {
        const body = linkSelectionToDoc(docRef.current.body, req.selected, req.span ?? undefined, linkTarget);
        next = body === null ? null : { ...docRef.current, body };
      }
      if (next === null) {
        setStatus(t("msg.cantAnchor")); // the doc changed under us during create() — don't overwrite it
        return;
      }
      setNewDocReq(null); // success only — close the modal now
      apply(next, { type: req.mode === "move" ? "text_moved" : "doc_created", payload: { path: linkTarget } });
      // Persist the original immediately (silent, like accepting a change): the new file already
      // exists on disk pointing back here, so the link/comment edit must be durable right away —
      // otherwise it lingers unsaved and a navigation round-trip can drop it.
      const saved = serialize(next);
      savedRef.current = saved;
      setDirty(false);
      void hostApi().save(saved, { kind: mode.applyKind, cadence }).then(() => setCheckpoint(saved));
    },
    [newDocReq, apply, t, cadence],
  );

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

  // Scroll BOTH panes to a 0-based source line. Unlike syncToLine (a preview click, which leaves the
  // preview put), this is for triggers that originate in neither pane — host side panels like the
  // TOC — so the preview scrolls (as if clicked from the source) AND the source scrolls (as if
  // clicked from the preview). This is the `scrollToLine` the SidePanelContext documents.
  const scrollBothToLine = useCallback((line: number) => {
    skipPreviewScroll.current = false; // let the activePreviewLine effect re-center the preview
    setActivePreviewLine(line);
    editorRef.current?.scrollToLine(line);
  }, []);

  // Keep a side panel mounted through its fold-out animation: when it closes (openPanel → null),
  // render the last panel briefly with the exit animation, then drop it — so closing matches the
  // open animation's duration instead of snapping shut.
  useEffect(() => {
    if (openPanel) {
      lastOpenPanelRef.current = (hostApi().sidePanels ?? []).find((p) => p.id === openPanel) ?? null;
      setClosingPanel(null); // (re)opened — cancel any in-flight close
      return;
    }
    if (!lastOpenPanelRef.current) return;
    setClosingPanel(lastOpenPanelRef.current);
    lastOpenPanelRef.current = null;
    const t = setTimeout(() => setClosingPanel(null), 540);
    return () => clearTimeout(t);
  }, [openPanel]);

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
      const prevDoc = docRef.current;
      // Merge comments rather than overwrite with the proposal's stale snapshot:
      // keep everything in the live doc (incl. comments the human added during
      // review) and append any agent-proposed comments not already present, so
      // accepting a proposal never discards review-time comments.
      const live = prevDoc.comments;
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
      // Decision made → push the accepted doc to the collaborative owners (comments → store, body →
      // the binding that owns the SOURCE pane + the shared/persisted doc). WITHOUT this, a collab
      // accept updated only the React preview: the binding-owned source stayed stale and the change
      // reverted on reload, because save({apply}) is a no-op in the unified-Yjs model (the server is
      // the sole writer of documents.body, from the binding). File-backed editors have no binding, so
      // they fall back to a silent canonical save (accepting a proposal must not end the turn).
      if (syncExternalDoc(finalDoc, prevDoc.comments, prevDoc.body)) {
        setCheckpoint(serialized);
      } else {
        void hostApi().save(serialized, { kind: "apply", cadence }).then(() => setCheckpoint(serialized));
      }
      void hostApi().clearProposal();
      void hostApi().logAction(acceptedCount === accepted.length ? "revision_accepted_all" : acceptedCount === 0 ? "revision_rejected_all" : "revision_hunk_accepted", { accepted: acceptedCount, total: accepted.length });
      setStatus(`applied agent revision (${acceptedCount}/${accepted.length} hunks)`);
    },
    [proposal, cadence, editingLocked, syncExternalDoc],
  );

  // --- inline review state (shared by the preview + source panes and the bar) ---
  // The diff hunks and per-hunk accept flags live here, so both panes render the
  // same review and the preview alone is a complete review surface in 1-pane mode.
  const reviewSegs = useMemo(() => (proposal ? lineSegments(proposal.baseBody, proposal.next.body) : []), [proposal]);
  const changeCount = useMemo(() => reviewSegs.filter(isChange).length, [reviewSegs]);
  const [accepted, setAccepted] = useState<boolean[]>([]);
  // Per-hunk edits to the PROPOSED (added) text, keyed by change-block index — the human can refine
  // a change before applying it. `editedSegs` overlays them onto the diff so both panes + Apply use
  // the edited text. Empty by default (the agent's proposal verbatim).
  const [edits, setEdits] = useState<Record<number, string[]>>({});
  const editedSegs = useMemo(() => {
    let ci = -1;
    return reviewSegs.map((s) => {
      if (!isChange(s)) return s;
      ci++;
      return edits[ci] ? { ...s, added: edits[ci]! } : s;
    });
  }, [reviewSegs, edits]);
  // Review is its own little undo/redo timeline (the doc isn't mutated until Apply): toggling a
  // switch, Accept/Reject all, and editing a hunk all snapshot {accepted, edits} so ⌘Z/⌘⇧Z step
  // through them while the review is open.
  const reviewHist = useRef<{ accepted: boolean[]; edits: Record<number, string[]> }[]>([]);
  const reviewFuture = useRef<{ accepted: boolean[]; edits: Record<number, string[]> }[]>([]);
  const [editingHunk, setEditingHunk] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  useEffect(() => {
    setAccepted(new Array(changeCount).fill(true));
    setEdits({});
    reviewHist.current = [];
    reviewFuture.current = [];
    setEditingHunk(null);
  }, [changeCount, proposal]);
  // Commit a review change through the undo timeline.
  const commitReview = useCallback(
    (nextAccepted: boolean[], nextEdits: Record<number, string[]>) => {
      reviewHist.current.push({ accepted, edits });
      if (reviewHist.current.length > 200) reviewHist.current.shift();
      reviewFuture.current = [];
      setAccepted(nextAccepted);
      setEdits(nextEdits);
    },
    [accepted, edits],
  );
  const toggleHunk = useCallback((idx: number, val: boolean) => commitReview(accepted.map((v, k) => (k === idx ? val : v)), edits), [commitReview, accepted, edits]);
  const setAllAccepted = useCallback((val: boolean) => commitReview(new Array(changeCount).fill(val), edits), [commitReview, changeCount, edits]);
  const reviewUndo = useCallback(() => {
    const prev = reviewHist.current.pop();
    if (!prev) return;
    reviewFuture.current.push({ accepted, edits });
    setEditingHunk(null);
    setAccepted(prev.accepted);
    setEdits(prev.edits);
    setStatus(t("msg.undid"));
  }, [accepted, edits]);
  const reviewRedo = useCallback(() => {
    const next = reviewFuture.current.pop();
    if (!next) return;
    reviewHist.current.push({ accepted, edits });
    setEditingHunk(null);
    setAccepted(next.accepted);
    setEdits(next.edits);
    setStatus(t("msg.redid"));
  }, [accepted, edits]);
  reviewUndoRef.current = reviewUndo;
  reviewRedoRef.current = reviewRedo;
  // Open the inline editor for a hunk (seed it with that hunk's current proposed text).
  const startEditHunk = useCallback(
    (idx: number) => {
      const blocks = editedSegs.filter(isChange);
      setEditDraft((blocks[idx]?.added ?? []).join("\n"));
      setEditingHunk(idx);
    },
    [editedSegs],
  );
  const saveEditHunk = useCallback(() => {
    if (editingHunk == null) return;
    commitReview(accepted, { ...edits, [editingHunk]: editDraft.split("\n") });
    setEditingHunk(null);
  }, [editingHunk, editDraft, commitReview, accepted, edits]);
  const cancelEditHunk = useCallback(() => setEditingHunk(null), []);
  const applyReview = useCallback(() => applyProposal(editedSegs, accepted), [applyProposal, editedSegs, accepted]);

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

  // Host-injected side panels (e.g. the cloud table of contents); none on the base path.
  const sidePanels = hostApi().sidePanels ?? [];
  const activePanel = sidePanels.find((p) => p.id === openPanel) ?? null;

  return (
    <div className="ap-app">
      <TopBar
        cadence={cadence}
        modes={modes}
        acceptance={acceptance}
        autoResolve={autoResolve}
        agentMode={agentMode}
        telemetry={telemetry}
        panes={panes}
        zoom={zoom}
        hasSelection={selectionText.length > 0}
        commentBlockTip={blockerTip(selBlocker)}
        onMode={onModeChange}
        onAcceptance={onAcceptanceChange}
        onAutoResolve={onAutoResolve}
        onAgentMode={onAgentMode}
        onTelemetry={onTelemetry}
        onPanes={setPanes}
        onZoom={onZoom}
        onAddComment={openComposer}
        onToggleFind={() => setFindOpen((v) => !v)}
        dirty={dirty && serialize(doc) !== checkpoint}
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
              <button
                className="ap-primary"
                onClick={async () => {
                  // Persist unsaved edits, then relaunch into the new version (falling
                  // back to a plain close if the host can't relaunch). Await the save
                  // first: the main-process restart calls app.exit(0) immediately, so an
                  // un-awaited save could be cut off before the write lands.
                  if (dirty) await hostApi().save(serialize(docRef.current), { kind: "apply", cadence });
                  if (hostApi().restartApp) await hostApi().restartApp!();
                  else await hostApi().closeWindow();
                }}
              >
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
          <TriSwitch
            state={changeCount > 0 && accepted.slice(0, changeCount).every(Boolean) ? "accept" : changeCount > 0 && accepted.slice(0, changeCount).every((v) => !v) ? "reject" : "mixed"}
            onAccept={() => setAllAccepted(true)}
            onReject={() => setAllAccepted(false)}
            disabled={editingLocked || !changeCount}
          />
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
            addComment(text, composer.target, composer.span);
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

      {newDocReq && (
        <NewDocModal
          mode={newDocReq.mode}
          initialTitle={newDocReq.mode === "move" ? moveDocTitle(newDocReq.selected) : newDocReq.selected.replace(/\s+/g, " ").trim()}
          initialPath={slugifyFilename(newDocReq.mode === "move" ? moveDocTitle(newDocReq.selected) : newDocReq.selected)}
          exists={!!newDocReq.existing}
          onPick={hostApi().newDoc?.pickPath ? (name) => hostApi().newDoc!.pickPath!(name) : null}
          draftOption={hostApi().newDoc?.draftOption ?? null}
          onSubmit={createNewDoc}
          onCancel={() => setNewDocReq(null)}
        />
      )}

      {props.onboarding && props.onFinishOnboarding && (
        <Onboarding signals={onboardingSignals} onFinish={props.onFinishOnboarding} onActiveStep={(id) => setForceSettingsOpen(id === "settings")} />
      )}

      {signInUrl && (
        <CloudSignInOverlay
          url={signInUrl}
          onDismiss={() => {
            setSignInUrl(null);
            hostApi().cloudSignIn?.cancel();
          }}
        />
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
            // New-doc actions: only when there's a selection AND the host can create docs.
            // Create wraps the selection in a link in place, so it's blocked on any anchor overlap
            // (a nested link would corrupt). Move *takes the text out*, carrying its comment threads
            // along, so it allows an enclosed anchor — only "not-found" (un-mappable selection)
            // disables it (a boundary-straddling anchor is caught at submit with a clear message).
            ...(ctxMenu.hasRawSel && hostApi().newDoc
              ? [
                  {
                    label: t("ctx.createDoc"),
                    disabled: editingLocked || ctxMenu.block !== null,
                    ...(ctxMenu.block ? { title: blockerTip(ctxMenu.block) ?? "" } : {}),
                    onSelect: () => openNewDoc("create"),
                  },
                  {
                    label: t("ctx.moveToDoc"),
                    // Far less restrictive than commenting: Move extracts whole blocks (by line span)
                    // and carries any enclosed comment threads, so multi-block / table / whitespace /
                    // anchor-overlapping selections are all fine. Only the turn-lock disables it; a
                    // genuinely un-locatable selection fails at submit with a clear message.
                    disabled: editingLocked,
                    onSelect: () => openNewDoc("move"),
                  },
                ]
              : []),
            { label: t("menu.findText"), disabled: !ctxMenu.hasSel, onSelect: () => { setFindSeed(ctxSelTextRef.current); setFindOpen(true); } },
            { label: t("menu.copy"), disabled: !ctxMenu.hasSel, onSelect: () => void navigator.clipboard?.writeText?.(ctxSelTextRef.current) },
            { label: t("menu.selectLine"), disabled: !ctxBlockRef.current, onSelect: () => selectNodeContents(ctxBlockRef.current) },
            { label: t("menu.selectAll"), onSelect: () => selectNodeContents(previewRef.current) },
          ]}
        />
      )}

      <div className="ap-main" style={{ zoom }}>
        {/* Host-injected side panels (e.g. the cloud TOC + version History): folded by default — a
            stack of small "bump" handles on the preview's top-left, one per panel; clicking one
            reveals that panel. The open panel auto-hides ~0.5s after the cursor leaves it. */}
        {sidePanels.length > 0 && !activePanel && !closingPanel && (
          <div className="ap-sidepanel-bumps">
            {sidePanels.map((p) => (
              <button key={p.id} className="ap-sidepanel-bump" title={p.title} aria-label={p.title} onClick={() => setOpenPanel(p.id)}>
                {p.icon ?? <span className="ap-iconbtn-fallback">{p.title.slice(0, 1)}</span>}
              </button>
            ))}
          </div>
        )}
        {(activePanel || closingPanel) && (
          <aside
            className={`ap-sidepanel${!activePanel && closingPanel ? " ap-sidepanel--closing" : ""}`}
            data-panel={(activePanel ?? closingPanel)!.id}
            onMouseEnter={
              activePanel
                ? () => {
                    if (panelHideTimer.current) {
                      clearTimeout(panelHideTimer.current);
                      panelHideTimer.current = null;
                    }
                  }
                : undefined
            }
            onMouseLeave={
              activePanel
                ? () => {
                    if (panelHideTimer.current) clearTimeout(panelHideTimer.current);
                    panelHideTimer.current = setTimeout(() => setOpenPanel(null), 500);
                  }
                : undefined
            }
          >
            {(activePanel ?? closingPanel)!.render({ body: doc.body, activeLine: activePreviewLine, scrollToLine: scrollBothToLine, close: () => setOpenPanel(null) })}
          </aside>
        )}
        <section
          className="ap-preview"
          ref={previewRef}
          data-onboard="preview"
          onContextMenu={(e) => {
            if (proposal && reviewOpen) return; // reviewing a diff — no comment menu
            e.preventDefault();
            // Capture the selection (text + range) and the block under the cursor NOW — clicking a
            // menu item can collapse the selection in some browsers, so the menu acts on what was
            // captured here. A click in the empty ("white") area below the text has no [data-line]
            // block and usually no selection → it opens the document-level comment item.
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
        >
          {proposal && reviewOpen ? (
            <DiffPreview segs={editedSegs} accepted={accepted} focused={reviewCursor} onToggle={toggleHunk} onEdit={startEditHunk} editingHunk={editingHunk} editDraft={editDraft} onEditDraft={setEditDraft} onEditSave={saveEditHunk} onEditCancel={cancelEditHunk} />
          ) : (
          <div
            className="ap-rendered"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
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
              <DiffSource segs={editedSegs} accepted={accepted} focused={reviewCursor} onToggle={toggleHunk} />
            ) : (
              <EditorErrorBoundary label="The source editor">
              <SourceEditor
                ref={editorRef}
                binding={hostApi().binding ?? null}
                value={doc.body}
                editable={!editingLocked}
                onChange={(body) => {
                  // Typing has its own (CodeMirror) undo; don't push app-level history per keystroke.
                  // Use a FUNCTIONAL update so we only ever change `body` and merge into the LATEST
                  // state — never `{...docRef.current, body}`, whose ref can lag behind rapid setDoc()s
                  // and clobber `comments`. (In collab a programmatic body edit fires this via the
                  // binding → ytext → CodeMirror, racing the comment the same action just added; the
                  // stale-ref form dropped that comment from the rail until the next store re-read.)
                  setDoc((d) => ({ ...d, body }));
                  // Dirty tracks the file-backed editor's unsaved state against savedRef. Skip it ONLY
                  // when the BODY is externally owned — i.e. a binding with setText persists it (then
                  // savedRef isn't advanced, so recomputing here would re-flag "unsaved" on every
                  // binding→CodeMirror round-trip right after syncExternalDoc cleared it). A
                  // commentStore-only host (no setText) still persists typed body edits via the
                  // file-backed save path, so it MUST keep tracking dirty — gating on commentStore here
                  // would silently drop those edits.
                  if (!hostApi().binding?.setText) setDirty(serialize({ ...docRef.current, body }) !== savedRef.current);
                }}
                onCursorLine={(line) => setActivePreviewLine(line)}
                onFind={() => setFindOpen(true)}
                find={findOpen && findOpts.inEditor && findOpts.query ? { query: findOpts.query, ci: findOpts.ci } : null}
                commentsForCopy={commentsForCopy}
                onCutComments={editingLocked ? undefined : onCutComments}
                onPasteComments={editingLocked ? undefined : onPasteComments}
              />
              </EditorErrorBoundary>
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
                  suggested={!autoResolve && suggestsResolve(o.thread)}
                  focused={focused === o.thread.root.id}
                  synced={syncedCommentId === o.thread.root.id}
                  disabled={editingLocked}
                  onFocus={() => focusComment(o.thread.root.id, false, true)}
                  onReply={(text) => apply(addReply(docRef.current, o.thread.root.id, text, userAuthorRef.current).doc, { type: "comment_created", payload: { parentId: o.thread.root.id } })}
                  onAnswer={(selected, text) => apply(setAnswer(docRef.current, o.thread.root.id, selected, text, userAuthorRef.current).doc, { type: "comment_answered", payload: { parentId: o.thread.root.id, selected } })}
                  onAnswerPending={(p) => setQuestionPending(o.thread.root.id, p)}
                  onResolve={(r) => apply(setResolved(docRef.current, o.thread.root.id, r), { type: "comment_resolved", payload: { id: o.thread.root.id, resolved: r } })}
                  onEdit={(id, text) => apply(editCommentText(docRef.current, id, text), { type: "comment_modified", payload: { id } })}
                  onDelete={(id) => apply(deleteComment(docRef.current, id), { type: "comment_deleted", payload: { id } })}
                />
              </Fragment>
            ))}
            {visible.length === 0 && <div className="ap-empty">{t("rail.emptyHint", { action: t("topbar.addComment") })}</div>}
            </div>
          </section>
          </>
        )}
      </div>

      <StatusBar
        modeLabelKey={mode.labelKey}
        status={status}
        dirty={dirty && serialize(doc) !== checkpoint}
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
    // Prefer the host's durable flag (desktop: ~/.inplan, survives across launches);
    // fall back to localStorage on hosts that don't manage it (web).
    const ra = realHostApi();
    if (typeof ra.onboarded === "boolean") return ra.onboarded ? "real" : "onboarding";
    try {
      return localStorage.getItem(ONBOARDED_KEY) ? "real" : "onboarding";
    } catch {
      return "real"; // storage blocked (private mode) → skip the tour rather than loop it
    }
  });
  const [apiReady, setApiReady] = useState(phase === "real");

  const installSample = useCallback(() => {
    const sample = createMemoryApi({ content: ONBOARDING_SAMPLE, settings: { autoResolve: false } }).api;
    const real = (window as unknown as { api?: Api }).api;
    sample.i18n = real?.i18n; // keep the user's locale during the tour
    // Surface the host's extra modes (e.g. the cloud's instant mode) during the tour too, so the
    // mode switch the user will see in the real editor isn't mysteriously absent in the tutorial.
    sample.extraModes = real?.extraModes;
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
    // Persist "tour shown" durably via the host (desktop: ~/.inplan); localStorage on web.
    const ra = realHostApi();
    if (ra.setOnboarded) {
      void ra.setOnboarded();
    } else {
      try {
        localStorage.setItem(ONBOARDED_KEY, "1");
      } catch {
        /* private mode — the tour will show again next launch, which is acceptable */
      }
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
  modes: ModeDescriptor[];
  acceptance: Acceptance;
  autoResolve: boolean;
  agentMode: "planning" | "implementation";
  telemetry: boolean;
  panes: 1 | 2 | 3;
  zoom: number;
  hasSelection: boolean;
  commentBlockTip: string | null; // why Add Comment is disabled (tooltip text), or null if allowed
  onMode: (c: Cadence, a: Acceptance) => void;
  onAcceptance: (a: Acceptance) => void;
  onAutoResolve: (v: boolean) => void;
  onAgentMode: (m: "planning" | "implementation") => void;
  onTelemetry: (v: boolean) => void;
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
      {/* Cadence toggle — only when the host advertises more than the built-in TURN mode (e.g.
          the cloud's instant mode). Non-turn modes disable when a presence-aware host has no agent. */}
      {props.modes.length > 1 && (
        <div className="ap-seg" role="group" aria-label="cadence">
          {props.modes.map((m) => (
            <button
              key={m.id}
              className={cadence === m.id ? "active" : ""}
              disabled={m.id !== "turn" && noAgent}
              title={m.id !== "turn" ? noAgentTitle : undefined}
              onClick={() => onMode(m.id, acceptance)}
            >
              {t(m.labelKey)}
            </button>
          ))}
        </div>
      )}
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
      {/* Host-injected side panels (e.g. the cloud table of contents) aren't toggled from the top
          bar — a "bump" handle on the preview's top-left reveals them (see ap-sidepanel-bump). */}
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
        {resolveMode(cadence, props.modes).showFinishTurn && (
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
          localCommand={hostApi().localAgentCommand}
        />
      )}
      <ProfileMenu
        user={profile?.user ?? null}
        actions={profile?.actions ?? []}
        identitySource={profile?.identitySource ?? null}
        onEditProfile={hostApi().profile?.setIdentity ? (name, email) => hostApi().profile!.setIdentity!(name, email) : undefined}
        acceptance={acceptance}
        autoResolve={props.autoResolve}
        agentMode={props.agentMode}
        telemetry={props.telemetry}
        onAcceptance={props.onAcceptance}
        onAutoResolve={props.onAutoResolve}
        onAgentMode={props.onAgentMode}
        onTelemetry={props.onTelemetry}
        onReplayTutorial={props.onReplayTutorial}
        forceOpen={props.forceSettingsOpen}
      />
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

/** Tri-state accept/reject-all control: the thumb sits left (all accepted), centre
 *  (mixed), or right (all rejected). The two ends are the actionable targets —
 *  clicking "accept" accepts every hunk, "reject" rejects every hunk; the centre is a
 *  display-only state reached when the per-hunk switches are mixed. Bidirectional: the
 *  position is derived from the hunks, and moving it sets them all. */
function TriSwitch({ state, onAccept, onReject, disabled }: { state: "accept" | "mixed" | "reject"; onAccept: () => void; onReject: () => void; disabled?: boolean }): JSX.Element {
  return (
    <span className={`ap-tri ap-tri--${state}${disabled ? " disabled" : ""}`} role="group" aria-label="accept or reject all changes">
      <button type="button" className="ap-tri-end ap-tri-accept" aria-pressed={state === "accept"} disabled={disabled} onClick={onAccept}>
        Accept all
      </button>
      <span className="ap-tri-track" aria-hidden="true">
        <span className="ap-tri-thumb" />
      </span>
      <button type="button" className="ap-tri-end ap-tri-reject" aria-pressed={state === "reject"} disabled={disabled} onClick={onReject}>
        Reject all
      </button>
    </span>
  );
}

/** The per-hunk control bar shared by both diff panes: an optional pencil (edit the
 *  proposal, only when the hunk is accepted), a "will be accepted/rejected" status to
 *  the left, and the accept switch on the right. */
function HunkBar({ idx, on, onToggle, onEdit, editing }: { idx: number; on: boolean; onToggle: (i: number, v: boolean) => void; onEdit?: (i: number) => void; editing?: boolean }): JSX.Element {
  return (
    <div className="ap-hunk-bar">
      <span className="ap-hunk-n">change {idx + 1}</span>
      <span className="ap-spacer" />
      {on && onEdit && (
        <button type="button" className={`ap-hunk-edit${editing ? " active" : ""}`} aria-label={`edit change ${idx + 1}`} title="Edit this change" onClick={() => onEdit(idx)}>
          <IconPencil />
        </button>
      )}
      <span className="ap-willbe">{on ? "will be accepted" : "will be rejected"}</span>
      <Switch checked={on} onChange={(v) => onToggle(idx, v)} ariaLabel={`accept change ${idx + 1}`} />
    </div>
  );
}

/** Inline diff rendered in the PREVIEW pane: changed blocks shown in place as
 *  rendered Markdown, with a per-hunk accept/reject toggle. This is the complete
 *  review surface in 1-pane mode (where the source pane isn't visible). */
function DiffPreview({
  segs,
  accepted,
  focused,
  onToggle,
  onEdit,
  editingHunk,
  editDraft,
  onEditDraft,
  onEditSave,
  onEditCancel,
}: {
  segs: DiffSegment[];
  accepted: boolean[];
  focused: number;
  onToggle: (i: number, v: boolean) => void;
  onEdit: (i: number) => void;
  editingHunk: number | null;
  editDraft: string;
  onEditDraft: (v: string) => void;
  onEditSave: () => void;
  onEditCancel: () => void;
}): JSX.Element {
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
        const editing = editingHunk === idx;
        return (
          <div key={i} data-hunk={idx} className={`ap-ihunk${on ? " accepted" : " rejected"}${focused === idx ? " focused" : ""}`}>
            <HunkBar idx={idx} on={on} onToggle={onToggle} onEdit={onEdit} editing={editing} />
            {s.removed && s.removed.length > 0 && (
              <div className="ap-ihunk-del" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.removed.join("\n"), () => false) }} />
            )}
            {editing ? (
              <div className="ap-ihunk-edit">
                <textarea
                  className="ap-ihunk-edit-ta"
                  value={editDraft}
                  autoFocus
                  rows={Math.min(12, Math.max(2, editDraft.split("\n").length))}
                  aria-label={`edit change ${idx + 1}`}
                  onChange={(e) => onEditDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      e.preventDefault();
                      onEditCancel();
                    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      onEditSave();
                    }
                  }}
                />
                <div className="ap-ihunk-edit-actions">
                  <button className="ap-link" aria-label={`cancel edit of change ${idx + 1}`} onClick={onEditCancel}>
                    Cancel
                  </button>
                  <button className="ap-primary" aria-label={`save edit of change ${idx + 1}`} onClick={onEditSave}>
                    Save
                  </button>
                </div>
              </div>
            ) : (
              s.added && s.added.length > 0 && <div className="ap-ihunk-add" dangerouslySetInnerHTML={{ __html: renderMarkdown(s.added.join("\n"), () => false) }} />
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
            <HunkBar idx={idx} on={on} onToggle={onToggle} />
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
  /** The agent flagged this thread's last comment `may_resolve` (auto-resolve off) → show a badge. */
  suggested: boolean;
  focused: boolean;
  synced: boolean;
  disabled: boolean;
  onFocus: () => void;
  onReply: (text: string) => void;
  onAnswer: (selected: string[], text: string) => void;
  onAnswerPending?: (pending: boolean) => void;
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
          <AuthorChip author={c.author} />
          <span className="ap-meta-time"> · <RelativeTime iso={c.date} /></span>
        </span>
        {/* Thread-level Resolve (icon) + the per-comment ⋯ menu, top-right on the meta line.
            Both wrappers are divs (not spans) so the block-level ⋯ popover nests validly. */}
        <div className="ap-meta-actions">
          {!isReply && (
            <button
              className="ap-resolve-btn"
              disabled={disabled}
              title={c.resolved ? t("rail.reopenThread") : t("rail.resolveThread")}
              aria-label={c.resolved ? t("rail.reopenThread") : t("rail.resolveThread")}
              onClick={(e) => {
                e.stopPropagation();
                props.onResolve(!c.resolved);
              }}
            >
              {c.resolved ? <IconReopen /> : <IconComplete />}
            </button>
          )}
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
      {props.suggested && <div className="ap-suggested-badge">✓ {t("rail.agentSuggestedResolve")}</div>}
      {renderComment(root, false)}
      {root.question && <QuestionChips question={root.question} disabled={disabled} answered={answeredSelection} onAnswer={props.onAnswer} onPending={props.onAnswerPending} />}
      {thread.replies.map((r) => renderComment(r, true))}

      {/* Resolve moved to the meta line (icon, top-right). Reply opens a box with Comment / Cancel. */}
      {!replying && (
        <div className="ap-row ap-thread-actions">
          <button className="ap-link" disabled={disabled} onClick={() => setReplying(true)}>
            {t("rail.reply")}
          </button>
        </div>
      )}
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

