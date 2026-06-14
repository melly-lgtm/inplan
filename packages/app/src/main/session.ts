// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendLog, CONTROL_LOG_VERSION, FsControlChannel, type LogEntry, LogEventType, readGlobalSettings, readLog, writeGlobalSettings } from "@inplan/core/node";
import type { Settings } from "@inplan/renderer";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Acceptance, Cadence, SaveOptions } from "@inplan/renderer";
import { docPaths, type DocPaths } from "./paths";

/**
 * Owns all on-disk state for one open document: reading/writing the file and its
 * sidecars (canonical base, autosave backups), appending to the control log, and
 * watching for the agent's out-of-band edits and its "done" signal.
 */
/** Most recent autosave backups to retain; older ones are pruned. */
const MAX_BACKUPS = 25;

export class Session {
  readonly paths: DocPaths;
  private backupSeq = 0;
  private closed = false;
  /** Latest unsaved state reported by the renderer, for the close prompt. */
  private pendingDirty = false;
  private pendingContent = "";

  setPending(dirty: boolean, content: string): void {
    this.pendingDirty = dirty;
    this.pendingContent = content;
  }
  get hasUnsaved(): boolean {
    return this.pendingDirty;
  }
  get pending(): string {
    return this.pendingContent;
  }

  constructor(file: string) {
    this.paths = docPaths(file);
    mkdirSync(this.paths.controlDir, { recursive: true });
    mkdirSync(this.paths.backupsDir, { recursive: true });
    // Continue numbering past any backups from previous sessions so sequence
    // numbers stay monotonic — otherwise restarts would reuse low numbers and
    // pruning could drop the freshest files.
    this.backupSeq = this.backupSeqs().at(-1) ?? 0;
  }

  /** Existing `autosave-<n>.md` sequence numbers in the backups dir, ascending. */
  private backupSeqs(): number[] {
    return readdirSync(this.paths.backupsDir)
      .map((name) => /^autosave-(\d+)\.md$/.exec(name)?.[1])
      .filter((n): n is string => n != null)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** Keep only the most recent MAX_BACKUPS autosave files. */
  private pruneBackups(): void {
    const seqs = this.backupSeqs();
    for (const n of seqs.slice(0, Math.max(0, seqs.length - MAX_BACKUPS))) {
      try {
        unlinkSync(join(this.paths.backupsDir, `autosave-${n}.md`));
      } catch {
        // best-effort; a missing/locked backup must not break saving
      }
    }
  }

  load(): { path: string; content: string } {
    const content = readFileSync(this.paths.file, "utf8");
    if (!existsSync(this.paths.canonicalPath)) {
      writeFileSync(this.paths.canonicalPath, content);
    }
    return { path: this.paths.file, content };
  }

  save(content: string, options: SaveOptions): void {
    if (options.kind === "backup") {
      const path = join(this.paths.backupsDir, `autosave-${++this.backupSeq}.md`);
      writeFileSync(path, content);
      this.pruneBackups();
      return;
    }
    // Update the file + base. "apply" (accepting a proposal) does this silently —
    // it must NOT log turn_ended, so accepting doesn't end the human's turn / wake
    // the agent; the human stays in control until they explicitly Finish turn.
    writeFileSync(this.paths.file, content);
    writeFileSync(this.paths.canonicalPath, content);
    if (options.kind === "apply") return;
    // Canonical save: wake the agent.
    const type = options.cadence === "turn" ? LogEventType.TurnEnded : LogEventType.DocumentEdited;
    appendLog(this.paths.logPath, { actor: "user", type, payload: { bytes: content.length } });
  }

  /** Record this editor process's own pid (authoritative for liveness checks). */
  logEditorPid(pid: number): void {
    appendLog(this.paths.logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid, v: CONTROL_LOG_VERSION } });
  }

  logAction(type: string, payload?: unknown): void {
    appendLog(this.paths.logPath, { actor: "user", type, ...(payload !== undefined ? { payload } : {}) });
  }

  /** Record that the editor followed a link away to `path`, so the agent attached
   *  to THIS doc steps down (its `wait` returns `navigated`) and re-attaches there. */
  logNavigatedAway(path: string): void {
    appendLog(this.paths.logPath, { actor: "user", type: LogEventType.NavigatedTo, payload: { path } });
  }

  setMode(cadence: Cadence, acceptance: Acceptance): void {
    appendLog(this.paths.logPath, { actor: "user", type: LogEventType.ModeChanged, payload: { cadence, acceptance } });
  }

  /** Global, cross-session settings (loaded by the renderer on launch). */
  getSettings(): Settings {
    return readGlobalSettings();
  }

  /** Persist global settings AND log the change so the agent wakes and the trail records it. */
  setSettings(settings: Settings): void {
    writeGlobalSettings(settings);
    appendLog(this.paths.logPath, { actor: "user", type: LogEventType.SettingsChanged, payload: settings });
  }

  complete(content: string): void {
    writeFileSync(this.paths.file, content);
    writeFileSync(this.paths.canonicalPath, content);
    // The content is now fully persisted, so nothing is unsaved. Clearing this keeps quitNow's
    // "flush pending on exit" guard (and the close prompt) from re-writing stale pending content
    // after a save — e.g. the interactive app:quit path saves `content`, then quitNow would
    // otherwise see hasUnsaved still true and overwrite it with `pending`.
    this.pendingDirty = false;
    this.pendingContent = content;
  }

  /** The parked Review-mode proposal, if one is pending (the file exists ⇔ undecided). */
  pendingProposal(): string | null {
    return existsSync(this.paths.proposedPath) ? readFileSync(this.paths.proposedPath, "utf8") : null;
  }

  /** Discard the parked proposal once the human has accepted/rejected it. */
  clearProposal(): void {
    if (existsSync(this.paths.proposedPath)) unlinkSync(this.paths.proposedPath);
  }

  /** Record why the session ended (logged at most once) so the agent's `wait` can report it. */
  logClose(reason: "completed" | "window_closed"): void {
    if (this.closed) return;
    this.closed = true;
    appendLog(this.paths.logPath, { actor: "user", type: LogEventType.SessionClosed, payload: { reason } });
  }

  /**
   * Drive the editor from the control-log protocol — NOT a raw working-file watch
   * — so the desktop behaves identically to the web/cloud `pump`. The CLI gate is
   * the single source of truth: it appends `document_edited` (agent) only for an
   * accepted edit (the working file then holds it), and `agent_revision_proposed`
   * for a parked Review proposal (with the working file already reverted to
   * canonical). Reacting to those events — instead of watching the file — means we
   * never adopt the agent's body write before the gate decides, which is what used
   * to produce the empty-diff race in Review (the baseline stayed put).
   */
  watch(handlers: WatchHandlers): () => void {
    let lastLogSeq = readLog(this.paths.logPath).at(-1)?.seq ?? 0;
    const onLog = () => {
      const entries = readLog(this.paths.logPath).filter((e) => e.seq > lastLogSeq);
      if (entries.length) lastLogSeq = entries.at(-1)!.seq;
      this.dispatchLog(entries, handlers);
    };
    // The ControlChannel seam (a web backend pushes via Realtime instead of polling).
    return new FsControlChannel(this.paths).subscribe(onLog);
  }

  /**
   * Fan a batch of new control-log entries out to the editor callbacks. Pure given
   * the on-disk sidecars (no watchers) — exposed for tests. An accepted agent edit
   * (`document_edited`) loads the working file (it now holds the revision); a parked
   * proposal (`agent_revision_proposed`) loads `proposed.md` for the diff — and is
   * NOT loaded as an external change, so the editor keeps its doc + the canonical
   * baseline, and the diff is never empty.
   */
  dispatchLog(entries: LogEntry[], handlers: WatchHandlers): void {
    if (!entries.length) return;
    if (entries.some((e) => e.type === LogEventType.AgentDoneSuggested)) handlers.onAgentDone();
    if (entries.some((e) => e.type === LogEventType.ReloadSuggested)) handlers.onReload();
    // Human-facing notes the agent relayed (one IPC per message, in order).
    for (const e of entries) {
      if (e.type === LogEventType.AgentMessage) {
        const text = (e.payload as { text?: string } | undefined)?.text;
        if (text) handlers.onAgentMessage(text, e.ts);
      }
    }
    if (entries.some((e) => e.type === LogEventType.AgentRevisionProposed)) {
      const proposed = this.pendingProposal();
      if (proposed != null) handlers.onProposal(proposed);
    }
    // An accepted agent edit: the working file holds the agent's revision (the gate
    // set canonical to it). Load it — this replaces the old raw working-file watch.
    if (entries.some((e) => e.actor === "agent" && e.type === LogEventType.DocumentEdited) && existsSync(this.paths.file)) {
      try {
        handlers.onExternalChange(readFileSync(this.paths.file, "utf8"));
      } catch {
        /* file mid-write — the next event will resync */
      }
    }
    // The agent re-engaged (revised the doc or just re-attached) — clear "thinking".
    if (entries.some((e) => e.actor === "agent" && (e.type === LogEventType.AgentRevised || e.type === LogEventType.DocumentEdited))) {
      handlers.onAgentActive();
    }
  }
}

/** The editor-facing callbacks the desktop shell relays to the renderer over IPC. */
export interface WatchHandlers {
  onExternalChange: (content: string) => void;
  onAgentDone: () => void;
  onAgentActive: () => void;
  onProposal: (content: string) => void;
  onReload: () => void;
  onAgentMessage: (text: string, ts: string) => void;
}
