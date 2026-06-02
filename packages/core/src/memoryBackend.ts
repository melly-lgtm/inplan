// SPDX-License-Identifier: AGPL-3.0-or-later
//
// In-process implementations of the deployment-portability seam.
// They hold all state in memory — no filesystem, no Electron — so the renderer
// can be mounted in a headless browser with a scripted "test agent" pushing
// control events straight into the channel, and so the same contract-test suite
// can run against `Fs`, `Memory` (and later `Supabase`) to prove the backends are
// interchangeable. Pure and browser-safe (exported from the package root).

import type { ControlChannel, DocumentStore, WaitToken } from "./channel";
import type { LogEntry, NewLogEntry } from "./controlLog";

export class MemoryControlChannel implements ControlChannel {
  private log: LogEntry[] = [];
  private cursor = 0;
  private lockToken: WaitToken | null = null;
  private present = false;
  private listeners = new Set<() => void>();

  /** Deterministic timestamp source (override in tests); defaults to wall clock. */
  constructor(private now: () => string = () => new Date().toISOString()) {}

  append(event: NewLogEntry): Promise<LogEntry> {
    const seq = this.log.length ? this.log[this.log.length - 1]!.seq + 1 : 1;
    const full: LogEntry = {
      seq,
      ts: event.ts ?? this.now(),
      actor: event.actor,
      type: event.type,
      ...(event.payload !== undefined ? { payload: event.payload } : {}),
    };
    this.log.push(full);
    for (const l of this.listeners) l();
    return Promise.resolve(full);
  }

  readSince(cursor: number): Promise<{ entries: LogEntry[]; cursor: number }> {
    const entries = this.log.filter((e) => e.seq > cursor);
    const next = this.log.length ? this.log[this.log.length - 1]!.seq : cursor;
    return Promise.resolve({ entries, cursor: next });
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  getCursor(): Promise<number> {
    return Promise.resolve(this.cursor);
  }
  setCursor(seq: number): Promise<void> {
    this.cursor = seq;
    return Promise.resolve();
  }

  claimLock(token: WaitToken): Promise<void> {
    this.lockToken = token;
    return Promise.resolve();
  }
  isSuperseded(token: WaitToken): Promise<boolean> {
    return Promise.resolve(this.lockToken !== null && this.lockToken !== token);
  }

  presence(): Promise<boolean> {
    return Promise.resolve(this.present);
  }
  /** Test hook: simulate the editor being present/absent. */
  setPresent(present: boolean): void {
    this.present = present;
  }
}

export class MemoryDocumentStore implements DocumentStore {
  private doc: string;
  private canonical: string | null = null;
  private proposed: string | null = null;
  private backups: string[] = [];

  constructor(initial = "") {
    this.doc = initial;
  }

  loadDoc(): Promise<string> {
    return Promise.resolve(this.doc);
  }
  saveDoc(content: string): Promise<void> {
    this.doc = content;
    return Promise.resolve();
  }
  getCanonical(): Promise<string | null> {
    return Promise.resolve(this.canonical);
  }
  setCanonical(content: string): Promise<void> {
    this.canonical = content;
    return Promise.resolve();
  }
  getProposed(): Promise<string | null> {
    return Promise.resolve(this.proposed);
  }
  setProposed(content: string): Promise<void> {
    this.proposed = content;
    return Promise.resolve();
  }
  clearProposed(): Promise<void> {
    this.proposed = null;
    return Promise.resolve();
  }
  backup(content: string): Promise<void> {
    this.backups.push(content);
    return Promise.resolve();
  }
  /** Test hook: inspect retained backups. */
  backupCount(): number {
    return this.backups.length;
  }
}
