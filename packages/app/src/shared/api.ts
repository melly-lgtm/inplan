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
  /** "canonical" wakes the agent (Finish turn / instant save); "backup" does not. */
  kind: "canonical" | "backup";
  cadence: Cadence;
}

/** The API exposed to the renderer via the preload contextBridge (`window.api`). */
export interface Api {
  /** Load the document this window was opened with. */
  load(): Promise<DocPayload>;
  /** Persist content. Canonical saves wake the agent; backups do not. */
  save(content: string, options: SaveOptions): Promise<void>;
  /** Append a single control-log action (actor "user"). */
  logAction(type: string, payload?: unknown): Promise<void>;
  /** Record a mode change (cadence/acceptance) to the control log. */
  setMode(cadence: Cadence, acceptance: Acceptance): Promise<void>;
  /** Write canonical, log session_closed, and quit. */
  complete(content: string): Promise<void>;
  /** The agent rewrote the document on disk. */
  onExternalChange(cb: (payload: DocPayload) => void): void;
  /** The agent signalled it thinks the plan is ready. */
  onAgentDone(cb: () => void): void;
  /** The agent re-engaged this round (revised the doc or re-attached) — clear "thinking". */
  onAgentActive(cb: () => void): void;
}

declare global {
  interface Window {
    api: Api;
  }
}
