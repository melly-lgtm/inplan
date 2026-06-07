// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A browser-safe implementation of the renderer's `Api` (window.api) backed by
// the in-memory ControlChannel / DocumentStore. It lets the React
// renderer run WITHOUT Electron — mounted in a headless browser for Playwright,
// or driven directly in a unit test — with a scripted "agent" pushing control
// events (auto-accept edits, Review proposals, done/reload signals) into it.
//
// Because the agent's edits arrive through explicit channels (onExternalChange
// for auto-accept, onProposal for Review), the renderer's diff base is never
// raced by a working-file watcher — the Review-mode adopt race can't occur here.

import { LogEventType, MemoryControlChannel, MemoryDocumentStore, type LogEntry } from "@inplan/core";
import type { Acceptance, Api, Cadence, DocPayload, SaveOptions, Settings } from "./api";

/** The scripted "agent" side of an in-memory session, for tests / harnesses. */
export interface MemoryAgent {
  /** Auto-accept: the agent rewrote the document (fires onExternalChange). */
  externalChange(content: string): void;
  /** Review mode: park a proposed revision (fires onProposal; getProposal returns it). */
  proposeRevision(content: string): void;
  /** The agent re-engaged this round (clears the editor's "thinking" state). */
  markActive(): void;
  /** The agent suggests the plan is ready. */
  suggestDone(): void;
  /** The agent has a new build and asks for a reload. */
  suggestReload(): void;
  /** The agent relayed a human-facing note (fires onAgentMessage). */
  message(text: string): void;
  /** Desktop-style in-window navigation to another doc (fires onNavigated). */
  navigate(content: string, path?: string): void;
  /** The full control log so far (for assertions). */
  log(): Promise<LogEntry[]>;
}

export interface MemorySession {
  api: Api;
  agent: MemoryAgent;
  /** True once the renderer completed/closed the session. */
  isClosed(): boolean;
}

export function createMemoryApi(opts: { content: string; settings?: Settings; backButton?: boolean }): MemorySession {
  const store = new MemoryDocumentStore(opts.content);
  const channel = new MemoryControlChannel();
  let settings: Settings = opts.settings ?? { autoResolve: true };
  let closed = false;

  const external: Array<(p: DocPayload) => void> = [];
  const proposal: Array<(p: { content: string }) => void> = [];
  const done: Array<() => void> = [];
  const active: Array<() => void> = [];
  const reload: Array<() => void> = [];
  const messages: Array<(m: { text: string; ts: string }) => void> = [];
  const navigated: Array<(p: DocPayload) => void> = [];
  // Register a callback and return a disposer that removes it (no listener buildup on remount).
  const subscribe = <T>(arr: T[], cb: T): (() => void) => {
    arr.push(cb);
    return () => {
      const i = arr.indexOf(cb);
      if (i >= 0) arr.splice(i, 1);
    };
  };

  const api: Api = {
    async load(): Promise<DocPayload> {
      if ((await store.getCanonical()) === null) await store.setCanonical(opts.content);
      return { path: "memory://doc", content: await store.loadDoc() };
    },
    async save(content: string, options: SaveOptions): Promise<void> {
      if (options.kind === "backup") {
        await store.backup(content);
        return;
      }
      await store.saveDoc(content);
      await store.setCanonical(content);
      if (options.kind === "apply") return; // silent — accepting a proposal must not wake the agent
      await channel.append({ actor: "user", type: options.cadence === "turn" ? LogEventType.TurnEnded : LogEventType.DocumentEdited, payload: { bytes: content.length } });
    },
    async logAction(type: string, payload?: unknown): Promise<void> {
      await channel.append({ actor: "user", type, ...(payload !== undefined ? { payload } : {}) });
    },
    async reportState(): Promise<void> {
      /* no unsaved-close prompt in memory */
    },
    async setMode(cadence: Cadence, acceptance: Acceptance): Promise<void> {
      await channel.append({ actor: "user", type: LogEventType.ModeChanged, payload: { cadence, acceptance } });
    },
    async getSettings(): Promise<Settings> {
      return settings;
    },
    async setSettings(s: Settings): Promise<void> {
      settings = s;
      await channel.append({ actor: "user", type: LogEventType.SettingsChanged, payload: s });
    },
    exit: {
      showBackButton: opts.backButton ?? false, // opt-in (web-like): expose the in-editor Back control
      quit(content: string, opts: { save: boolean; startBuild: boolean }): void {
        if (opts.save) {
          void store.saveDoc(content);
          void store.setCanonical(content);
        }
        void channel.append({ actor: "user", type: LogEventType.SessionClosed, payload: { reason: opts.startBuild ? "completed" : "window_closed" } });
        closed = true;
      },
    },
    onExternalChange: (cb) => subscribe(external, cb),
    onProposal: (cb) => subscribe(proposal, cb),
    onAgentDone: (cb) => subscribe(done, cb),
    onAgentActive: (cb) => subscribe(active, cb),
    onReload: (cb) => subscribe(reload, cb),
    onAgentMessage: (cb) => subscribe(messages, cb),
    onNavigated: (cb) => subscribe(navigated, cb),
    async closeWindow(): Promise<void> {
      closed = true;
    },
    async getProposal(): Promise<string | null> {
      return store.getProposed();
    },
    async clearProposal(): Promise<void> {
      await store.clearProposed();
    },
    async openDoc(): Promise<void> {
      /* in-memory harness: no navigation */
    },
  };

  const agent: MemoryAgent = {
    externalChange(content: string) {
      void store.saveDoc(content);
      void store.setCanonical(content);
      void channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: content.length } });
      for (const cb of external) cb({ path: "memory://doc", content });
    },
    proposeRevision(content: string) {
      void store.setProposed(content);
      void channel.append({ actor: "agent", type: LogEventType.AgentRevisionProposed, payload: { bytes: content.length } });
      for (const cb of proposal) cb({ content });
    },
    markActive() {
      void channel.append({ actor: "agent", type: LogEventType.AgentRevised });
      for (const cb of active) cb();
    },
    suggestDone() {
      void channel.append({ actor: "agent", type: LogEventType.AgentDoneSuggested });
      for (const cb of done) cb();
    },
    suggestReload() {
      void channel.append({ actor: "agent", type: LogEventType.ReloadSuggested });
      for (const cb of reload) cb();
    },
    message(text: string) {
      // One timestamp for both the log entry and the callback, so they never drift
      // (mirrors the real host, where the callback gets the appended entry's ts).
      const ts = new Date().toISOString();
      void channel.append({ actor: "agent", type: LogEventType.AgentMessage, payload: { text }, ts });
      for (const cb of messages) cb({ text, ts });
    },
    navigate(content: string, path = "memory://doc2") {
      void store.saveDoc(content);
      void store.setCanonical(content);
      for (const cb of navigated) cb({ path, content });
    },
    async log(): Promise<LogEntry[]> {
      return (await channel.readSince(0)).entries;
    },
  };

  return { api, agent, isClosed: () => closed };
}
