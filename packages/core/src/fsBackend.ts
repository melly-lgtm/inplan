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
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  unwatchFile,
  watch,
  watchFile,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ControlChannel, DocumentStore, ProposalInput, ProposalRow, WaitToken } from "./channel";
import { mintProposalId } from "./channel";
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

  // `sinceMs` is ignored: liveness here is "is the editor PROCESS alive", which flips to false the
  // instant the window closes — there's no lingering-heartbeat TTL window to disambiguate.
  presence(_sinceMs?: number): Promise<boolean> {
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

  // Proposal rows live in a JSON file beside the other sidecars; `proposedPath` stays as a
  // derived copy of the CURRENT pending content (readable at a glance, and what pre-rows code
  // wrote). A single local proposer, so "mine" is unqualified.
  private proposalsPath(): string {
    return `${this.paths.proposedPath}.rows.json`;
  }

  /** Whether row-backed proposal state exists for this doc at all (vs the legacy content file). */
  hasProposalHistory(): boolean {
    return existsSync(this.proposalsPath());
  }

  private static readonly STATES = new Set(["pending", "accepted", "partially_accepted", "rejected", "superseded", "withdrawn"]);

  private static isValidRow(r: unknown): r is ProposalRow {
    const x = r as Partial<ProposalRow> | null;
    return !!x && typeof x.id === "string" && typeof x.content === "string" && typeof x.baseHash === "string" && typeof x.baseContent === "string" && typeof x.state === "string" && FsDocumentStore.STATES.has(x.state) && typeof x.createdAt === "string";
  }

  private readRows(): ProposalRow[] {
    const raw = this.readOrNull(this.proposalsPath());
    if (raw === null) return [];
    try {
      const rows = JSON.parse(raw) as unknown;
      // Valid JSON is not integrity: every row must carry the full lifecycle shape, or lookups
      // would serve invalid state downstream. Anything else is quarantined like a parse failure.
      if (Array.isArray(rows) && rows.every((r) => FsDocumentStore.isValidRow(r))) return rows as ProposalRow[];
    } catch {
      /* fall through to preservation */
    }
    // A damaged rows file must never be silently replaced by the next write — it is the proposal
    // history. Move the bytes aside (evidence, hand-recoverable) and start fresh. If even the
    // rename fails, FAIL the operation: returning [] here would let the next writeRows publish an
    // empty replacement over the original via tmp+rename, destroying the history it exists to keep.
    renameSync(this.proposalsPath(), `${this.proposalsPath()}.corrupt-${Date.now()}`);
    return [];
  }

  /**
   * Advisory per-doc lock around every read-modify-publish of the rows file: the desktop editor
   * (main process) and a CLI can share one sidecar, and interleaved mutations would lose a
   * lifecycle update. mkdir is the atomic primitive; a stale lock (a crashed holder) is broken
   * after 2s. Mutations here are a few file ops — well under the staleness window.
   */
  private withRowsLock<T>(run: () => T): T {
    const lockDir = `${this.proposalsPath()}.lock`;
    const ownerPath = join(lockDir, "owner");
    const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        mkdirSync(lockDir);
        writeFileSync(ownerPath, token);
        break;
      } catch {
        let stale = false;
        try {
          stale = Date.now() - statSync(lockDir).mtime.getTime() > 2_000;
        } catch {
          continue; // holder released between our attempt and the stat — retry immediately
        }
        if (stale) {
          try {
            rmSync(lockDir, { recursive: true, force: true });
          } catch {
            /* someone else broke it first */
          }
          continue;
        }
        if (Date.now() > deadline) throw new Error(`proposal rows lock is held: ${lockDir}`);
        const buf = new SharedArrayBuffer(4);
        Atomics.wait(new Int32Array(buf), 0, 0, 25); // sync sleep without spinning a core
      }
    }
    try {
      return run();
    } finally {
      // Ownership-checked release: if a holder overstays the staleness window and its lock was
      // broken, its release must not tear down the NEW holder's lock (that would readmit a third
      // process mid-mutation and lose rows to last-write-wins).
      try {
        if (readFileSync(ownerPath, "utf8") === token) rmSync(lockDir, { recursive: true, force: true });
      } catch {
        /* broken by staleness — the lock is someone else's now */
      }
    }
  }

  private writeRows(rows: ProposalRow[]): void {
    // Atomic publish (tmp + rename), then refresh the derived pending-content file.
    const tmp = `${this.proposalsPath()}.tmp`;
    writeFileSync(tmp, JSON.stringify(rows, null, 2));
    renameSync(tmp, this.proposalsPath());
    const pending = rows.find((r) => r.state === "pending");
    try {
      if (pending) writeFileSync(this.paths.proposedPath, pending.content);
      else if (existsSync(this.paths.proposedPath)) unlinkSync(this.paths.proposedPath);
    } catch {
      /* derived copy only */
    }
  }

  createProposal(input: ProposalInput): Promise<{ id: string }> {
    return Promise.resolve(
      this.withRowsLock(() => {
        const rows = this.readRowsAdoptingLegacy();
        // Identical content with no explicit id re-parks the SAME proposal (a retry, not a
        // successor): minting a fresh id would supersede the original identity on every retry.
        const pendingSame = input.id ? undefined : rows.find((r) => r.state === "pending" && r.content === input.content);
        const id = input.id ?? pendingSame?.id ?? mintProposalId();
        const existing = rows.find((r) => r.id === id);
        if (existing) {
          if (existing.state === "pending") Object.assign(existing, { content: input.content, baseHash: input.baseHash, baseContent: input.baseContent });
        } else {
          for (const r of rows) if (r.state === "pending") r.state = "superseded";
          rows.push({ id, content: input.content, baseHash: input.baseHash, baseContent: input.baseContent, state: "pending", createdAt: new Date().toISOString() });
        }
        this.writeRows(rows);
        return { id };
      }),
    );
  }

  /** Rows, adopting a legacy pre-rows sidecar exactly once: a `proposedPath` content file with no
   *  rows file is an old park — it becomes a real pending row (minted id) so the full lifecycle
   *  (withdraw/decide/supersede) applies to it instead of the file lingering forever. */
  private readRowsAdoptingLegacy(): ProposalRow[] {
    const rows = this.readRows();
    if (rows.length > 0 || this.hasProposalHistory()) return rows;
    const legacy = this.readOrNull(this.paths.proposedPath);
    if (legacy === null) return rows;
    return [{ id: mintProposalId(), content: legacy, baseHash: "", baseContent: "", state: "pending", createdAt: new Date().toISOString() }];
  }

  myPendingProposal(): Promise<ProposalRow | null> {
    return Promise.resolve(
      this.withRowsLock(() => {
        const rows = this.readRowsAdoptingLegacy();
        const pending = rows.find((r) => r.state === "pending") ?? null;
        // Persist an adoption so the minted identity is stable across calls.
        if (pending && !this.hasProposalHistory()) this.writeRows(rows);
        return pending;
      }),
    );
  }

  getProposal(id: string): Promise<ProposalRow | null> {
    // Under the lock like every other rows access: a lookup must not race a concurrent
    // quarantine-recovery rename from another process mid-publish.
    return Promise.resolve(this.withRowsLock(() => this.readRows().find((r) => r.id === id) ?? null));
  }

  withdrawProposal(id: string): Promise<void> {
    this.withRowsLock(() => {
      const rows = this.readRowsAdoptingLegacy();
      const r = rows.find((x) => x.id === id);
      if (r && r.state === "pending") {
        r.state = "withdrawn";
        this.writeRows(rows);
      }
    });
    return Promise.resolve();
  }

  decideProposal(id: string, state: "accepted" | "partially_accepted" | "rejected"): Promise<void> {
    this.withRowsLock(() => {
      const rows = this.readRowsAdoptingLegacy();
      const r = rows.find((x) => x.id === id);
      if (r && r.state === "pending") {
        r.state = state;
        r.decidedAt = new Date().toISOString();
        this.writeRows(rows);
      }
    });
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
