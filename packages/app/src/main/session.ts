// SPDX-License-Identifier: AGPL-3.0-or-later

import { appendLog, LogEventType, readLog } from "@agent-planner/core/node";
import { existsSync, mkdirSync, readFileSync, unwatchFile, watchFile, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Acceptance, Cadence, SaveOptions } from "../shared/api";
import { docPaths, type DocPaths } from "./paths";

/**
 * Owns all on-disk state for one open document: reading/writing the file and its
 * sidecars (canonical base, autosave backups), appending to the control log, and
 * watching for the agent's out-of-band edits and its "done" signal.
 */
export class Session {
  readonly paths: DocPaths;
  /** Content the editor last wrote, used to distinguish our writes from the agent's. */
  private lastWritten = "";
  private backupSeq = 0;

  constructor(file: string) {
    this.paths = docPaths(file);
    mkdirSync(this.paths.controlDir, { recursive: true });
    mkdirSync(this.paths.backupsDir, { recursive: true });
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
      return;
    }
    // Canonical save: update the file + base and wake the agent.
    writeFileSync(this.paths.file, content);
    writeFileSync(this.paths.canonicalPath, content);
    this.lastWritten = content;
    const type = options.cadence === "turn" ? LogEventType.TurnEnded : LogEventType.DocumentEdited;
    appendLog(this.paths.logPath, { actor: "user", type, payload: { bytes: content.length } });
  }

  /** Record this editor process's own pid (authoritative for liveness checks). */
  logEditorPid(pid: number): void {
    appendLog(this.paths.logPath, { actor: "agent", type: LogEventType.EditorPid, payload: { pid } });
  }

  logAction(type: string, payload?: unknown): void {
    appendLog(this.paths.logPath, { actor: "user", type, ...(payload !== undefined ? { payload } : {}) });
  }

  setMode(cadence: Cadence, acceptance: Acceptance): void {
    appendLog(this.paths.logPath, { actor: "user", type: LogEventType.ModeChanged, payload: { cadence, acceptance } });
  }

  complete(content: string): void {
    writeFileSync(this.paths.file, content);
    writeFileSync(this.paths.canonicalPath, content);
    this.lastWritten = content;
    appendLog(this.paths.logPath, { actor: "user", type: LogEventType.SessionClosed });
  }

  /**
   * Watch for the agent rewriting the file out from under us, and for its
   * `agent_done_suggested` signal in the control log. Polling-based for
   * cross-platform reliability.
   */
  watch(handlers: { onExternalChange: (content: string) => void; onAgentDone: () => void; onAgentActive: () => void }): () => void {
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
