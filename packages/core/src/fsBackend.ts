// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Filesystem implementation of the deployment-portability seam:
// the local desktop backend. It wraps today's sidecar-file mechanics behind the
// `ControlChannel` / `DocumentStore` interfaces so `cli` / `app` can depend on
// the interface and a web backend (Supabase) can be dropped in unchanged.
//
// Node-only — imported via `@inplan/core/node`, never from the package root.

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  unwatchFile,
  watch,
  watchFile,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ControlChannel, DocumentStore, WaitToken } from "./channel";
import { LogEventType, type LogEntry, type NewLogEntry } from "./controlLog";
import { appendLog, readLog, readLogIncrement } from "./controlLogFs";

/** Sidecar paths an fs backend needs (a structural subset of the CLI `DocPaths`). */
export interface FsBackendPaths {
  file: string;
  logPath: string;
  canonicalPath: string;
  proposedPath: string;
  backupsDir: string;
  cursorPath: string;
  waitLockPath: string;
}

/** Most recent autosave backups to retain; older ones are pruned. */
const MAX_BACKUPS = 25;

/** True if process `pid` is currently alive (EPERM still means it exists). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class FsControlChannel implements ControlChannel {
  // Incremental-read state: bytes already consumed + the entries parsed so far.
  // Lets readSince parse only newly-appended bytes (O(new)) rather than re-reading
  // the whole log each poll, while still seeing appends from other processes
  // (the editor) since it re-stats to the current size every call.
  private byteOffset = 0;
  private parsed: LogEntry[] = [];

  constructor(private readonly paths: Pick<FsBackendPaths, "logPath" | "cursorPath" | "waitLockPath">) {}

  append(event: NewLogEntry): Promise<LogEntry> {
    return Promise.resolve(appendLog(this.paths.logPath, event));
  }

  readSince(cursor: number): Promise<{ entries: LogEntry[]; cursor: number }> {
    let inc = readLogIncrement(this.paths.logPath, this.byteOffset);
    if (inc.reset) {
      // File shrank/was replaced (truncation, compaction) — drop the cache and reparse.
      this.parsed = [];
      this.byteOffset = 0;
      inc = readLogIncrement(this.paths.logPath, 0);
    }
    if (inc.entries.length) this.parsed.push(...inc.entries);
    this.byteOffset = inc.offset;
    const entries = this.parsed.filter((e) => e.seq > cursor);
    const next = this.parsed.length ? this.parsed[this.parsed.length - 1]!.seq : cursor;
    return Promise.resolve({ entries, cursor: next });
  }

  subscribe(onChange: () => void): () => void {
    // Event-driven via fs.watch (FSEvents/inotify) instead of stat-polling, with a
    // short debounce to coalesce a burst of appends into one wake. The log is
    // append-only and never renamed, so the watch handle stays valid. Falls back
    // to watchFile polling if fs.watch is unavailable (e.g. the file doesn't exist
    // yet, or a platform/filesystem that doesn't support it).
    let timer: ReturnType<typeof setTimeout> | null = null;
    const fire = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(onChange, 50);
    };
    try {
      const watcher = watch(this.paths.logPath, fire);
      return () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      };
    } catch {
      const listener = () => fire();
      watchFile(this.paths.logPath, { interval: 200 }, listener);
      return () => {
        if (timer) clearTimeout(timer);
        unwatchFile(this.paths.logPath, listener);
      };
    }
  }

  getCursor(): Promise<number> {
    if (!existsSync(this.paths.cursorPath)) return Promise.resolve(0);
    const n = Number(readFileSync(this.paths.cursorPath, "utf8").trim());
    return Promise.resolve(Number.isFinite(n) ? n : 0);
  }

  setCursor(seq: number): Promise<void> {
    writeFileSync(this.paths.cursorPath, String(seq));
    return Promise.resolve();
  }

  claimLock(token: WaitToken): Promise<void> {
    writeFileSync(this.paths.waitLockPath, token);
    return Promise.resolve();
  }

  isSuperseded(token: WaitToken): Promise<boolean> {
    if (!existsSync(this.paths.waitLockPath)) return Promise.resolve(false);
    return Promise.resolve(readFileSync(this.paths.waitLockPath, "utf8").trim() !== token);
  }

  presence(): Promise<boolean> {
    const log = readLog(this.paths.logPath);
    for (let i = log.length - 1; i >= 0; i--) {
      if (log[i]!.type === LogEventType.EditorPid) {
        const pid = (log[i]!.payload as { pid?: number } | undefined)?.pid;
        return Promise.resolve(typeof pid === "number" && isProcessAlive(pid));
      }
    }
    return Promise.resolve(false);
  }
}

export class FsDocumentStore implements DocumentStore {
  constructor(private readonly paths: Pick<FsBackendPaths, "file" | "canonicalPath" | "proposedPath" | "backupsDir">) {}

  private readOrNull(path: string): string | null {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  }

  loadDoc(): Promise<string> {
    return Promise.resolve(readFileSync(this.paths.file, "utf8"));
  }

  saveDoc(content: string): Promise<void> {
    writeFileSync(this.paths.file, content);
    return Promise.resolve();
  }

  getCanonical(): Promise<string | null> {
    return Promise.resolve(this.readOrNull(this.paths.canonicalPath));
  }

  setCanonical(content: string): Promise<void> {
    writeFileSync(this.paths.canonicalPath, content);
    return Promise.resolve();
  }

  getProposed(): Promise<string | null> {
    return Promise.resolve(this.readOrNull(this.paths.proposedPath));
  }

  setProposed(content: string): Promise<void> {
    writeFileSync(this.paths.proposedPath, content);
    return Promise.resolve();
  }

  clearProposed(): Promise<void> {
    if (existsSync(this.paths.proposedPath)) unlinkSync(this.paths.proposedPath);
    return Promise.resolve();
  }

  backup(content: string): Promise<void> {
    mkdirSync(this.paths.backupsDir, { recursive: true });
    const seqs = this.backupSeqs();
    const next = (seqs.at(-1) ?? 0) + 1;
    writeFileSync(join(this.paths.backupsDir, `autosave-${next}.md`), content);
    // Keep only the most recent MAX_BACKUPS.
    for (const n of seqs.slice(0, Math.max(0, seqs.length + 1 - MAX_BACKUPS))) {
      try {
        unlinkSync(join(this.paths.backupsDir, `autosave-${n}.md`));
      } catch {
        // best-effort
      }
    }
    return Promise.resolve();
  }

  private backupSeqs(): number[] {
    if (!existsSync(this.paths.backupsDir)) return [];
    return readdirSync(this.paths.backupsDir)
      .map((name) => /^autosave-(\d+)\.md$/.exec(name)?.[1])
      .filter((n): n is string => n != null)
      .map(Number)
      .sort((a, b) => a - b);
  }
}
