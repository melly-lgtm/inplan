// SPDX-License-Identifier: AGPL-3.0-or-later

import type { Text as YText } from ***REMOVED***;
import type { Awareness } from "***REMOVED***/awareness";

/** A live-collaboration binding: a shared ***REMOVED*** + presence awareness. When a host
 *  exposes one (web/cloud), the source editor binds to it (multiplayer); otherwise
 *  the editor is the usual controlled single-writer (desktop / tests). */
export interface CollabBinding {
  ytext: YText;
  awareness: Awareness;
}

/** Collaboration cadence. */
export type Cadence = "turn" | "instant";
/** Agent-change acceptance policy. */
export type Acceptance = "auto" | "review";

export interface DocPayload {
  path: string;
  content: string;
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
   * True when this host derives agent attachment from live presence (the web/cloud):
   * then a null `agentLocation` means *no agent is connected*, so the editor disables
   * Instant mode + Finish-turn (nothing to hand the turn to). On the desktop the local
   * agent is implicit (no presence room), so this is omitted and those stay enabled.
   */
  presenceAware?: boolean;
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
  /** Confirmed quit: optionally save the latest content, optionally signal the agent the
   *  plan is ready, then leave (desktop: close the window; web: return to the plan list). */
  quit(content: string, opts: { save: boolean; startBuild: boolean }): void;
}

/** Host-specific new-doc creation for the Create Doc / Move Text to New Doc actions. The renderer
 *  owns the title/filename defaults and the body edit (replacing the selection with a link); the
 *  host owns *where* the doc lands and returns the relative link target to embed. */
export interface NewDocController {
  /** Open the host's location picker seeded with `suggestedName`; the chosen path, or null if
   *  cancelled. Optional — a host without a file browser (e.g. web, where the user just types a
   *  repo-relative path) omits it and the modal shows no Browse button. (Desktop: a save dialog.) */
  pickPath?(suggestedName: string): Promise<string | null>;
  /** Create the doc at `path` with `content`; resolves to the relative link target to embed in
   *  the source (e.g. "./section.md"), or null on failure. */
  create(path: string, content: string): Promise<{ linkTarget: string } | null>;
}

export interface Api {
  /** Load the document this window was opened with. */
  load(): Promise<DocPayload>;
  /** Persist content. Canonical saves wake the agent; backups do not. */
  save(content: string, options: SaveOptions): Promise<void>;
  /** Append a single control-log action (actor "user"). */
  logAction(type: string, payload?: unknown): Promise<void>;
  /** Tell main about unsaved state + latest content, so window-close can prompt Save/Don't Save. */
  reportState(dirty: boolean, content: string): Promise<void>;
  /** Record a mode change (cadence/acceptance) to the control log. */
  setMode(cadence: Cadence, acceptance: Acceptance): Promise<void>;
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
  /** Live-collaboration binding for the source editor, if the host provides one
   *  (web/cloud). Absent/null on desktop + tests (single-writer). */
  collab?: CollabBinding | null;
  /** Identity + presence for the shared `<ProfileMenu>`, when the host wires one
   *  (web/cloud, and the signed-in desktop app). Absent on tests / single-writer. */
  profile?: ProfileController | null;
  /** Localization seam, when the host wires one (web for everyone; paid desktop).
   *  Absent ⇒ the editor runs in its built-in English. */
  i18n?: I18nController | null;
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
}

declare global {
  interface Window {
    api: Api;
  }
}

// The host's `window.api` is exposed via Electron's contextBridge, which makes it a
// read-only property — it can't be reassigned. The onboarding sandbox therefore can't
// swap `window.api`; instead all renderer code reads the api through `hostApi()`, and
// AppRoot installs/clears a temporary override for the duration of the tour.
let _apiOverride: Api | null = null;

/** Route renderer api access through an optional override (the onboarding sample). */
export function setApiOverride(api: Api | null): void {
  _apiOverride = api;
}

/** The api the renderer should use right now: the onboarding override if set, else the host. */
export function hostApi(): Api {
  return _apiOverride ?? (window as unknown as { api: Api }).api;
}

/** The real host api, ignoring any onboarding override — for host-level concerns like the
 *  desktop window-close intercept (the throwaway sample doesn't implement those). */
export function realHostApi(): Api {
  return (window as unknown as { api: Api }).api;
}
