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

/** Global user settings that affect agent behavior (persisted in ~/.inplan/settings.json). */
export interface Settings {
  /** Agent resolves a thread after incorporating it (true), or leaves it for the human (false). */
  autoResolve: boolean;
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
  /** The doc's current agent-provisioning policy (the badge doubles as its control).
   *  Present + `onSetAgentPolicy` ⇒ the menu renders the picker. */
  agentPolicy?: AgentPolicy;
  /** Change the provisioning policy (host persists it). */
  onSetAgentPolicy?: (policy: AgentPolicy) => void | Promise<void>;
}

/** A reactive source of {@link ProfileState}. `get()` must return a referentially
 *  stable snapshot until the state actually changes (it backs `useSyncExternalStore`). */
export interface ProfileController {
  get(): ProfileState;
  subscribe(cb: (s: ProfileState) => void): () => void;
}

/** The API exposed to the renderer via the preload contextBridge (`window.api`). */
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
  /** Write canonical, log session_closed, and quit. */
  complete(content: string): Promise<void>;
  /** The agent rewrote the document on disk. */
  onExternalChange(cb: (payload: DocPayload) => void): void;
  /** The agent signalled it thinks the plan is ready. */
  onAgentDone(cb: () => void): void;
  /** The agent re-engaged this round (revised the doc or re-attached) — clear "thinking". */
  onAgentActive(cb: () => void): void;
  /** The agent has a new build ready and asks the human to close the window to reload. */
  onReload(cb: () => void): void;
  /** Close the editor window (used by the reload countdown's auto-close). */
  closeWindow(): Promise<void>;
  /** Read the parked Review-mode proposal pending decision (null if none) — for durable re-show on launch. */
  getProposal(): Promise<string | null>;
  /** Discard the parked proposal after the human accepts/rejects it. */
  clearProposal(): Promise<void>;
  /** A Review-mode proposal was parked by the agent this session — surface it for review. */
  onProposal(cb: (payload: { content: string }) => void): void;
  /**
   * Open another document by its resolved path (a relative Markdown link, joined
   * against this doc's path). Local: the sibling file; web: /docs/<org>/<repo>/<path>.
   */
  openDoc(target: string): Promise<void>;
  /** Live-collaboration binding for the source editor, if the host provides one
   *  (web/cloud). Absent/null on desktop + tests (single-writer). */
  collab?: CollabBinding | null;
  /** Identity + presence for the shared `<ProfileMenu>`, when the host wires one
   *  (web/cloud, and the signed-in desktop app). Absent on tests / single-writer. */
  profile?: ProfileController | null;
}

declare global {
  interface Window {
    api: Api;
  }
}
