// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Extension } from "@codemirror/state";
import type { ReactNode } from "react";
import type { Comment } from "@inplan/core";
import type { CommentStore } from "./commentStore";
import type { ModeDescriptor, ModePolicy } from "./mode";

/** A binding a plugin can inject to drive the source editor from an external document source.
 *  Open-core ships no such source; a plugin that has one supplies the CodeMirror `extensions` that
 *  bind the editor and the source's current `getText`. When present, the editor binds to it instead
 *  of being a controlled single-writer. */
export interface EditorBinding {
  /** CodeMirror extensions that bind the editor to the external document. */
  extensions: Extension[];
  /** The external document's current text, used to seed the editor (the binding then owns content). */
  getText: () => string;
  /** Apply a PROGRAMMATIC body change — a span-comment's `[text](#cmt-id)` anchor link,
   *  find/replace, move-blocks, body undo/redo — to the bound document. Once a binding is present
   *  the editor's controlled `value` is ignored (the binding owns content; see SourceEditor), so an
   *  edit that doesn't originate from typing in CodeMirror has no other way to reach the shared doc.
   *  Implementations should apply it as a MINIMAL edit (so a concurrent remote edit elsewhere isn't
   *  clobbered) and write the shared document DIRECTLY, so it works even when the source pane
   *  (CodeMirror) isn't mounted. Optional: a binding without it simply can't accept programmatic
   *  body edits (open-core's file-backed editor has no binding and uses the controlled value). */
  setText?: (text: string) => void;
}

/** Context the renderer hands a {@link SidePanelSpec} on every render: the live document and
 *  the imperative levers a panel needs (scroll the editor + preview to a line; close itself). */
export interface SidePanelContext {
  /** The current document body (Markdown). */
  body: string;
  /** The source line (0-based) the panes are currently centered on, or null — for highlighting
   *  the panel's active entry. */
  activeLine: number | null;
  /** Scroll BOTH the preview and the source editor to a 0-based source line. */
  scrollToLine: (line: number) => void;
  /** Close the panel (clears its menu-bar toggle). */
  close: () => void;
}

/** A host-injected side panel: a menu-bar toggle that slides a panel into the left of the editor
 *  layout. Open-core ships none — a host (the web app, or the entitled desktop plugin) provides
 *  them via {@link Api.sidePanels}, e.g. a table of contents. Deliberately feature-agnostic: the
 *  renderer owns the toggle button, the slide-in slot, and cross-pane scrolling; the host owns the
 *  panel's content + label + glyph. The panel renders in the host's React tree (it returns a node),
 *  so a plugin bundle must share the renderer's React runtime (treat react/react-dom as externals). */
export interface SidePanelSpec {
  /** Stable id — the React key, the menu-bar toggle's identity, and the persisted "open panel". */
  id: string;
  /** Localized label for the toggle (tooltip + aria-label). The host owns its own strings. */
  title: string;
  /** Toggle glyph (host-provided node). Falls back to the title's first character when absent. */
  icon?: ReactNode;
  /** Render the panel body; called on each render with fresh {@link SidePanelContext}. */
  render: (ctx: SidePanelContext) => ReactNode;
}

/** Collaboration cadence — a mode id (see ModeDescriptor). Open-core's only built-in is "turn";
 *  a host can advertise more via `Api.extraModes`. */
export type Cadence = "turn" | (string & {});
/** Agent-change acceptance policy. */
export type Acceptance = "auto" | "review";

export interface DocPayload {
  path: string;
  content: string;
  /** When true, the editor opens read-only: the body + comments can't be edited and the turn
   *  can't be handed off — the doc is viewable + downloadable only. Used by hosts that archive
   *  a doc (e.g. the cloud deactivates a doc over the plan's active-doc cap). Absent = editable. */
  readOnly?: boolean;
}

export interface SaveOptions {
  /** "canonical" wakes the agent (Finish turn / instant save); "backup" does not;
   *  "apply" persists canonical silently (accepting a proposal — does NOT end the turn). */
  kind: "canonical" | "backup" | "apply";
  cadence: Cadence;
}

/** Which mode the agent operates in: drafting/refining the plan, or building it. */
export type AgentMode = "planning" | "implementation";

/** Global user settings that affect agent behavior (persisted in ~/.inplan/settings.json). */
export interface Settings {
  /** Agent resolves a thread after incorporating it (true), or leaves it for the human (false). */
  autoResolve: boolean;
  /** "planning" (draft/refine the doc) or "implementation" (build it). Optional for
   *  back-compat; defaults to "planning". */
  agentMode?: AgentMode;
  /** Opt-in anonymous usage analytics (off/absent = nothing sent). */
  telemetry?: boolean;
  /** How the agent's body edits are accepted — "review" (park as a proposal) or "auto" (apply
   *  directly). Global preference read on launch; defaults to "review". */
  acceptance?: Acceptance;
}

/** Where an agent is attached right now — derived from live presence by the host
 *  (the local CLI joins as `local`; the managed runtime as `cloud`), never stored. */
export type AgentLocation = "local" | "cloud";

/** How a cloud doc auto-provisions an agent when a human opens it:
 *  - `auto`   — attach a managed cloud agent when no local agent is present;
 *  - `local`  — wait for the user's local agent; never auto-attach a cloud one;
 *  - `manual` — don't auto-attach; the user connects an agent explicitly. */
export type AgentPolicy = "auto" | "local" | "manual";

/** A host-injected profile-menu action (DI, like the rest of the Api): the local
 *  app supplies "Collaborate on Cloud" + sign-in/out; the web "Save locally" /
 *  "Download" + sign-out. The shared menu just renders and invokes them. */
export interface ProfileMenuItem {
  label: string;
  onSelect: () => void | Promise<void>;
  /** Visual emphasis for the primary call-to-action (e.g. Collaborate on Cloud). */
  primary?: boolean;
  /** Secondary/destructive treatment (e.g. Sign out). */
  danger?: boolean;
  disabled?: boolean;
}

/** Reactive identity + presence state behind the shared `<ProfileMenu>`. */
export interface ProfileState {
  /** The signed-in user, or null when not authenticated (host supplies a Sign in action). */
  user: { name: string; email?: string } | null;
  /** Where an agent is attached, for the badge; null when none is. */
  agentLocation: AgentLocation | null;
  /** Host-injected menu actions, rendered in order. */
  actions: ProfileMenuItem[];
  /**
   * True when this host derives agent attachment from live presence (the web/cloud).
   * Combined with {@link agentAvailable}, this decides whether Instant mode + Finish-turn
   * are enabled. On the desktop the local agent is implicit (no presence room), so this
   * is omitted and those controls stay enabled.
   */
  presenceAware?: boolean;
  /**
   * True when an agent is *available* for this doc even if not connected as a presence peer —
   * i.e. the managed cloud agent is entitled + the doc's policy is `auto`, OR a local agent is
   * connected. The cloud agent is event-driven (it doesn't sit in the presence room), so a null
   * `agentLocation` no longer means "no agent": Instant + Finish-turn enable when `agentAvailable`
   * is true. Hosts that don't set this fall back to the `agentLocation != null` check.
   */
  agentAvailable?: boolean;
  /** The doc's current agent-provisioning policy. Present + `onSetAgentPolicy` ⇒ the
   *  menu-bar agent indicator renders the connection picker. */
  agentPolicy?: AgentPolicy;
  /** Change the provisioning policy (host persists it). */
  onSetAgentPolicy?: (policy: AgentPolicy) => void | Promise<void>;
  /** The attached agent's model, for the indicator label (e.g. "Opus 4.8"). */
  agentModel?: string;
  /** Managed-agent quota for the indicator pie: fraction used [0..1] + overage flag. */
  agentQuota?: { usedPct: number; overage: boolean };
  /** True when the cloud agent runs on the org's own (BYO) key — indicator goes dark blue. */
  agentByoKey?: boolean;
  /** Where the human identity was resolved from (cloud/git/manual); null when unset
   *  (the menu then prompts the human to set up their profile). */
  identitySource?: "cloud" | "git" | "manual" | null;
}

/** A reactive source of {@link ProfileState}. `get()` must return a referentially
 *  stable snapshot until the state actually changes (it backs `useSyncExternalStore`). */
export interface ProfileController {
  get(): ProfileState;
  subscribe(cb: (s: ProfileState) => void): () => void;
  /** Persist the human's local identity (the Edit-profile form). Optional: hosts that
   *  don't support a manual identity simply omit it. */
  setIdentity?(name: string, email?: string): Promise<void>;
}

/** A flat catalog of UI strings for one locale: key → translated text. Values may
 *  contain `{name}` placeholders, interpolated by `t()`. */
export type Catalog = Record<string, string>;

/** Reactive i18n state supplied by the host (the seam). The open core ships English
 *  only; hosts register additional locale catalogs and choose the active locale — the
 *  web for everyone, the desktop only for paid users (so non-English local UI is the
 *  paid perk). `t()` falls back to the built-in English base, so the editor is always
 *  fully functional even with no host i18n. */
export interface I18nState {
  /** Active BCP-47 locale (e.g. "en", "fr", "ja"). */
  locale: string;
  /** Catalogs by locale (the active one is consulted first, then English). */
  catalogs: Record<string, Catalog>;
  /** Locales to offer in the picker (those with catalogs), in display order. */
  available: { code: string; label: string }[];
  /** Switch the active locale (the host persists it + re-renders). */
  setLocale(locale: string): void | Promise<void>;
}

/** A reactive source of {@link I18nState} (same contract as ProfileController). */
export interface I18nController {
  get(): I18nState;
  subscribe(cb: (s: I18nState) => void): () => void;
}

/** The API exposed to the renderer via the preload contextBridge (`window.api`). */
/**
 * How the host handles leaving a document. The shared quit-confirmation dialog (in the
 * renderer) calls `quit()` once the user confirms; the host does the save/notify/leave.
 */
export interface ExitController {
  /** Show an in-editor "Back" button (web → returns to the plan list). Desktop sets false:
   *  the OS window-close is the exit (it calls `onRequest` to surface the same dialog). */
  showBackButton: boolean;
  /** Subscribe to a host-initiated quit attempt (desktop window-close intercept) so the
   *  renderer can show the confirmation dialog. Absent on web (the Back button drives it).
   *  Returns a disposer to remove the listener (so it doesn't stack across remounts). */
  onRequest?(cb: () => void): (() => void) | void;
  /** Confirmed quit: always save the latest content, optionally signal the agent the plan is
   *  ready (build mode), then leave (desktop: close the window; web: return to the plan list). */
  quit(content: string, opts: { startBuild: boolean }): void;
}

/** Host-specific new-doc creation for the Create Doc / Move Text to New Doc actions. The renderer
 *  owns the title/filename defaults and the body edit (replacing the selection with a link); the
 *  host owns *where* the doc lands and returns the relative link target to embed. */
export interface NewDocController {
  /** Open the host's location picker seeded with `suggestedName`; the chosen path, or null if
   *  cancelled. Optional — a host without a file browser (e.g. web, where the user just types a
   *  repo-relative path) omits it and the modal shows no Browse button. (Desktop: a save dialog.) */
  pickPath?(suggestedName: string): Promise<string | null>;
  /** When set, the Create-Doc modal offers an optional "draft from a prompt" field. Open-core has no
   *  notion of *who* may draft or *how*; the host supplies this (with its own localized strings) only
   *  when it can draft the new doc from a prompt — e.g. a paid cloud org whose managed agent drafts it.
   *  Absent ⇒ no prompt field (desktop / free / tests). */
  draftOption?: { label: string; placeholder: string } | null;
  /** Create the doc at `path` with `content`. `status: "created"` wrote a new file; `"exists"` means
   *  the file was already there (nothing written) so the caller can offer to link/append instead.
   *  `linkTarget` is the relative link to embed (e.g. "./section.md"); null on a hard failure.
   *  `opts.draftPrompt` (only when {@link draftOption} is offered and the user filled it): the host
   *  seeds the new doc to be agent-drafted from this prompt instead of just the title. */
  create(path: string, content: string, opts?: { draftPrompt?: string }): Promise<{ status: "created" | "exists"; linkTarget: string } | null>;
  /** Append moved blocks (+ their comment threads) to the EXISTING doc at `path`: merges `body` after
   *  its current body and `comments` into its comment block. Resolves to the relative link target, or
   *  null on failure. Used by "Move Blocks → Append to the existing doc". */
  append?(path: string, body: string, comments: Comment[]): Promise<{ linkTarget: string } | null>;
}

export interface Api {
  /** Load the document this window was opened with. */
  load(): Promise<DocPayload>;
  /** Persist content. Canonical saves wake the agent; backups do not. */
  save(content: string, options: SaveOptions): Promise<void>;
  /** Append a single control-log action (actor "user"). */
  logAction(type: string, payload?: unknown): Promise<void>;
  /** Fire an opt-in, anonymous usage event (no-op when telemetry is off — the host gates it).
   *  Optional: a host without analytics simply omits it. Props must be non-PII (enums/counts/bools). */
  telemetry?(event: string, props?: Record<string, string | number | boolean | undefined>): void;
  /** Tell main about unsaved state + latest content, so window-close can prompt Save/Don't Save. */
  reportState(dirty: boolean, content: string): Promise<void>;
  /** Record a mode change (cadence/acceptance) to the control log. `policy` carries the mode's
   *  gate semantics (wake/lock) so the mode-agnostic CLI can honour it; defaults to turn. */
  setMode(cadence: Cadence, acceptance: Acceptance, policy?: ModePolicy): Promise<void>;
  /** Extra collaboration modes a host advertises beyond the built-in TURN (e.g. the cloud's
   *  instant mode). The editor renders a toggle per mode and reads each one's policy. */
  extraModes?: ModeDescriptor[];
  /** Read global user settings (loaded on launch). */
  getSettings(): Promise<Settings>;
  /** Persist global user settings and log the change to this doc's control log. */
  setSettings(settings: Settings): Promise<void>;
  /** Leaving the document: the host shows/handles the quit-confirmation flow. */
  exit?: ExitController;
  /** The agent rewrote the document on disk. */
  onExternalChange(cb: (payload: DocPayload) => void): () => void;
  /** The agent signalled it thinks the plan is ready. */
  onAgentDone(cb: () => void): () => void;
  /** The agent re-engaged this round (revised the doc or re-attached) — clear "thinking". */
  onAgentActive(cb: () => void): () => void;
  /** The agent has a new build ready and asks the human to close the window to reload. */
  onReload(cb: () => void): () => void;
  /** The agent relayed a human-facing note (via `inplan message`) — surfaced in the status bar. */
  onAgentMessage?(cb: (msg: { text: string; ts: string }) => void): (() => void) | void;
  /** Close the editor window (used by the reload countdown's auto-close). */
  closeWindow(): Promise<void>;
  /** Read the parked Review-mode proposal pending decision (null if none) — for durable re-show on launch. */
  getProposal(): Promise<string | null>;
  /** Discard the parked proposal after the human accepts/rejects it. */
  clearProposal(): Promise<void>;
  /** A Review-mode proposal was parked by the agent this session — surface it for review. */
  onProposal(cb: (payload: { content: string }) => void): () => void;
  /**
   * Open another document by its resolved path (a relative Markdown link, joined
   * against this doc's path). Local: the sibling file; web: /docs/<org>/<repo>/<path>.
   */
  openDoc(target: string): Promise<void>;
  /** Host-specific new-doc creation (Create Doc / Move Text to New Doc). Absent ⇒ the renderer
   *  hides those menu items (e.g. tests, or a host that can't create docs). */
  newDoc?: NewDocController | null;
  /** Desktop only: navigate the window's back/forward history of opened docs.
   *  Absent on web (the browser's own history handles it) + tests. */
  navigate?(dir: "back" | "forward"): Promise<void>;
  /** Desktop only: whether back/forward navigation is currently possible (drives
   *  the nav buttons' enabled state). */
  onNavState?(cb: (s: { canBack: boolean; canForward: boolean }) => void): (() => void) | void;
  /** Desktop only: the window swapped to another doc (in-window link follow); the
   *  renderer resets to this payload like a fresh load. */
  onNavigated?(cb: (payload: DocPayload) => void): (() => void) | void;
  /** External-source binding for the source editor, if a plugin provides one. Absent/null on the
   *  base single-writer path (no plugin) + tests. */
  binding?: EditorBinding | null;
  /** Comment seam: when a plugin provides an external store, the editor sources comments from it
   *  and routes comment CRUD through it (so comments live in the plugin's shared store, not in the
   *  serialized body via save()). Absent ⇒ the editor owns comments in its parsed document and
   *  serializes them on save (the base single-writer path / tests). */
  commentStore?: CommentStore | null;
  /** Host-injected side panels (a menu-bar toggle + a left slide-in slot), e.g. a table of
   *  contents. Open-core ships none; a host provides them — the web app for everyone, the
   *  entitled desktop plugin for paid users — so the feature is gated simply by whether the
   *  host injects it. Absent/empty ⇒ no panel toggles (the base path / tests). */
  sidePanels?: SidePanelSpec[] | null;
  /** Identity + presence for the shared `<ProfileMenu>`, when the host wires one
   *  (web/cloud, and the signed-in desktop app). Absent on tests / single-writer. */
  profile?: ProfileController | null;
  /** Localization seam, when the host wires one (web for everyone; paid desktop).
   *  Absent ⇒ the editor runs in its built-in English. */
  i18n?: I18nController | null;
  /** A copy-pasteable shell command a LOCAL agent runs to serve THIS document (cloud only — e.g.
   *  `inplan wait --remote <docId>`). Shown in the agent menu when the connection preference is
   *  "Wait for my local agent", so the human can hand it to their local coding agent. Absent on the
   *  desktop/file-backed editor (the agent is already local). */
  localAgentCommand?: string;
  /** Desktop only: a newer published npm version exists (checked on launch).
   *  Web auto-updates via reload; tests omit this. */
  onUpdateAvailable?(cb: (info: { current: string; latest: string }) => void): (() => void) | void;
  /** Desktop only: run the npm self-update; resolves `ok` on success (then restart). */
  applyUpdate?(): Promise<{ ok: boolean }>;
  /** Desktop only: relaunch into the freshly-installed version (same doc). */
  restartApp?(): Promise<void>;
  /** First-run tour already shown? Host-provided durable flag (desktop: ~/.inplan).
   *  Undefined when the host doesn't manage it (web falls back to localStorage). */
  onboarded?: boolean;
  /** Persist that the tour has been shown (completed or skipped). */
  setOnboarded?(): Promise<void> | void;
  /** Desktop only: cloud sign-in handoff. The host asks the renderer to show a sign-in page in an
   *  in-app modal overlay (`onOpen` with the URL to frame), tears it down when the handoff settles
   *  (`onClose`), and `cancel` aborts it when the overlay is dismissed. Absent on the web host,
   *  which has its own auth UI. */
  cloudSignIn?: {
    onOpen(cb: (url: string) => void): () => void;
    onClose(cb: () => void): () => void;
    cancel(): void;
  };
}

declare global {
  interface Window {
    api: Api;
  }
}

// The host's `window.api` is exposed via Electron's contextBridge, which makes it a
// read-only, frozen property — it can't be reassigned or mutated. So renderer code never
// touches `window.api` directly; it reads the api through `hostApi()`, layered as:
//   _apiOverride (the onboarding sample, temporary) ?? _hostApi (the installed base) ?? window.api
// A host that augments the base api (the desktop merges the paid live-collab binding at
// startup) installs it via `setHostApi`; AppRoot installs/clears the onboarding override on
// top, and clearing it falls back to the augmented base — never losing the augmentation.
let _apiOverride: Api | null = null;
let _hostApi: Api | null = null;

/** Install the base host api the renderer uses (the desktop calls this to merge the verified
 *  live-collab binding onto `window.api`, which can't be reassigned). Persists beneath any
 *  temporary onboarding override. */
export function setHostApi(api: Api): void {
  _hostApi = api;
}

/** Route renderer api access through an optional override (the onboarding sample). */
export function setApiOverride(api: Api | null): void {
  _apiOverride = api;
}

/** The real host api (installed base, else `window.api`), ignoring any onboarding override —
 *  for host-level concerns like the desktop window-close intercept and the collab merge. */
export function realHostApi(): Api {
  return _hostApi ?? (window as unknown as { api: Api }).api;
}

/** The api the renderer should use right now: the onboarding override if set, else the host. */
export function hostApi(): Api {
  return _apiOverride ?? realHostApi();
}
