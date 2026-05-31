// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendLog, CONTROL_LOG_VERSION, LogEventType, readGlobalSettings, readLog, writeGlobalSettings } from "@inplan/core/node";
import type { Settings } from "../shared/api";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Acceptance, Cadence, SaveOptions } from "../shared/api";
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
  /** Content the editor last wrote, used to distinguish our writes from the agent's. */
  private lastWritten = "";
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
    this.lastWritten = content;
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
    this.lastWritten = content;
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
    this.lastWritten = content;
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
   * Watch for the agent rewriting the file out from under us, and for its
   * `agent_done_suggested` signal in the control log. Polling-based for
   * cross-platform reliability.
   */
  watch(handlers: {
    onExternalChange: (content: string) => void;
    onAgentDone: () => void;
    onAgentActive: () => void;
    onProposal: (content: string) => void;
    onReload: () => void;
  }): () => void {
    let lastLogSeq = readLog(this.paths.logPath).at(-1)?.seq ?? 0;

    const onFile = () => {
      // The file may have just been deleted/moved (watcher fires on removal too).
      if (!existsSync(this.paths.file)) return;
      let content: string;
      try {
        content = readFileSync(this.paths.file, "utf8");
      } catch {
        return;
      }
      if (content !== this.lastWritten) {
        this.lastWritten = content;
        handlers.onExternalChange(content);
      }
    };
    const onLog = () => {
      const entries = readLog(this.paths.logPath).filter((e) => e.seq > lastLogSeq);
      if (entries.length) lastLogSeq = entries.at(-1)!.seq;
      if (entries.some((e) => e.type === LogEventType.AgentDoneSuggested)) {
        handlers.onAgentDone();
      }
      if (entries.some((e) => e.type === LogEventType.ReloadSuggested)) {
        handlers.onReload();
      }
      // A Review-mode proposal was parked by the CLI gate — surface it for review.
      if (entries.some((e) => e.type === LogEventType.AgentRevisionProposed)) {
        const proposed = this.pendingProposal();
        if (proposed != null) handlers.onProposal(proposed);
      }
      // The agent re-engaged (revised the doc or just re-attached) — clear "thinking".
      if (entries.some((e) => e.actor === "agent" && (e.type === LogEventType.AgentRevised || e.type === LogEventType.DocumentEdited))) {
        handlers.onAgentActive();
      }
    };

    watchFile(this.paths.file, { interval: 400 }, onFile);
    watchFile(this.paths.logPath, { interval: 400 }, onLog);
    return () => {
      unwatchFile(this.paths.file, onFile);
      unwatchFile(this.paths.logPath, onLog);
    };
  }
}
