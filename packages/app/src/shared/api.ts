// SPDX-License-Identifier: AGPL-3.0-or-later

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
  /** Read the parked Review-mode proposal pending decision (null if none) — for durable re-show on launch. */
  getProposal(): Promise<string | null>;
  /** Discard the parked proposal after the human accepts/rejects it. */
  clearProposal(): Promise<void>;
  /** A Review-mode proposal was parked by the agent this session — surface it for review. */
  onProposal(cb: (payload: { content: string }) => void): void;
}

declare global {
  interface Window {
    api: Api;
  }
}
