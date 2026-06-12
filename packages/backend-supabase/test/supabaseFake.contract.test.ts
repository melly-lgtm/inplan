// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the shared backend contract against the Supabase adapters over an in-memory
// fake `SupabaseClient` (no creds, no network), plus targeted error-path / presence /
// factory tests. The env-gated supabase.contract.test.ts proves the same adapters
// against a live Postgres; this proves their query logic in CI without secrets.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { SupabaseControlChannel } from "../src/supabaseControlChannel";
import { SupabaseDocumentStore } from "../src/supabaseDocumentStore";
import { runControlChannelContract, runDocumentStoreContract } from "./contract";

vi.mock("@supabase/supabase-js", () => ({ createClient: vi.fn(() => ({ __fake: "client" })) }));

type Row = Record<string, unknown>;

/** A minimal in-memory fake of the subset of the supabase-js query builder the
 *  adapters use: from().insert/upsert/update/select + eq/gt/order/single/maybeSingle,
 *  and channel().on().subscribe() / removeChannel() with INSERT notifications. */
function makeFakeSupabase() {
  const tables: Record<string, Row[]> = { events: [], cursors: [], locks: [], editor_presence: [], documents: [], doc_versions: [] };
  let seq = 0;
  const channels: Array<{ table: string | null; cb: (() => void) | null; subscribed: boolean }> = [];

  class Q {
    private op: "select" | "insert" | "upsert" | "update" = "select";
    private payload: Row | Row[] = {};
    private patch: Row = {};
    private onConflict?: string;
    private wantSelect = false;
    private eqs: Array<[string, unknown]> = [];
    private gts: Array<[string, unknown]> = [];
    private ords: Array<{ col: string; asc: boolean }> = [];
    private lim?: number;
    constructor(private table: string) {}
    insert(payload: Row | Row[]) { this.op = "insert"; this.payload = payload; return this; }
    upsert(payload: Row, opts?: { onConflict?: string }) { this.op = "upsert"; this.payload = payload; this.onConflict = opts?.onConflict; return this; }
    update(patch: Row) { this.op = "update"; this.patch = patch; return this; }
    select(_cols?: string) { this.wantSelect = true; return this; }
    eq(col: string, val: unknown) { this.eqs.push([col, val]); return this; }
    gt(col: string, val: unknown) { this.gts.push([col, val]); return this; }
    order(col: string, opts?: { ascending?: boolean }) { this.ords.push({ col, asc: opts?.ascending !== false }); return this; }
    limit(n: number) { this.lim = n; return this; }
    single() { const r = this.exec(); return Promise.resolve(r.error ? r : { data: (r.data as Row[])?.[0] ?? null, error: null }); }
    maybeSingle() { const r = this.exec(); return Promise.resolve({ data: (r.data as Row[])?.[0] ?? null, error: r.error }); }
    then<T>(resolve: (v: { data: unknown; error: unknown }) => T) { return Promise.resolve(this.exec()).then(resolve); }
    private match(row: Row) {
      return this.eqs.every(([c, v]) => row[c] === v) && this.gts.every(([c, v]) => (row[c] as number) > (v as number));
    }
    private exec(): { data: unknown; error: unknown } {
      const t = tables[this.table]!;
      if (this.op === "insert") {
        const rows = (Array.isArray(this.payload) ? this.payload : [this.payload]).map((r) => {
          const row: Row = { ...r };
          if (this.table === "events") { row.seq = ++seq; row.ts = new Date().toISOString(); }
          return row;
        });
        t.push(...rows);
        for (const _ of rows) for (const c of channels) if (c.subscribed && c.table === this.table) c.cb?.();
        return { data: this.wantSelect ? rows : null, error: null };
      }
      if (this.op === "upsert") {
        const r = this.payload as Row;
        const keys = (this.onConflict ?? "").split(",").map((s) => s.trim()).filter(Boolean);
        const idx = keys.length ? t.findIndex((x) => keys.every((k) => x[k] === r[k])) : -1;
        if (idx >= 0) t[idx] = { ...t[idx], ...r }; else t.push({ ...r });
        return { data: null, error: null };
      }
      if (this.op === "update") {
        for (const row of t) if (this.match(row)) Object.assign(row, this.patch);
        return { data: null, error: null };
      }
      let rows = t.filter((r) => this.match(r));
      if (this.ords.length) {
        // multi-column sort (priority order); generic compare so created_at (ISO strings) and
        // numeric ids/seq both order correctly.
        rows = [...rows].sort((a, b) => {
          for (const { col, asc } of this.ords) {
            const c = (a[col]! < b[col]! ? -1 : a[col]! > b[col]! ? 1 : 0) * (asc ? 1 : -1);
            if (c) return c;
          }
          return 0;
        });
      }
      if (this.lim != null) rows = rows.slice(0, this.lim);
      return { data: rows, error: null };
    }
  }

  const db = {
    from: (table: string) => new Q(table),
    channel: () => {
      const c = { table: null as string | null, cb: null as (() => void) | null, subscribed: false };
      return { on: (_ev: string, opts: { table: string }, cb: () => void) => { c.table = opts.table; c.cb = cb; return { subscribe: () => { c.subscribed = true; channels.push(c); return c; } }; } };
    },
    removeChannel: (c: { subscribed: boolean }) => { c.subscribed = false; return Promise.resolve(); },
  } as unknown as SupabaseClient;

  return { db, tables, seedDoc: (id: string) => tables.documents.push({ id }) };
}

runControlChannelContract("Supabase (fake client)", () => new SupabaseControlChannel(makeFakeSupabase().db, "doc-1", "agent"));
runDocumentStoreContract("Supabase (fake client)", () => {
  const f = makeFakeSupabase();
  f.seedDoc("doc-1");
  return new SupabaseDocumentStore(f.db, "doc-1");
});

describe("SupabaseDocumentStore version history", () => {
  it("backup dedups a no-op snapshot (same body as the latest) and records provenance", async () => {
    const f = makeFakeSupabase();
    f.seedDoc("d1");
    const s = new SupabaseDocumentStore(f.db, "d1");
    await s.backup("v1", { actor: "agent", kind: "turn", author: "Opus 4.8" });
    await s.backup("v1"); // same body → skipped
    await s.backup("v2");
    expect(f.tables.doc_versions.length).toBe(2);
    expect(f.tables.doc_versions[0]).toMatchObject({ doc_id: "d1", body: "v1", actor: "agent", kind: "turn", author: "Opus 4.8" });
  });

  it("listVersions returns this doc's checkpoints newest-first (id breaks created_at ties), capped by limit", async () => {
    const f = makeFakeSupabase();
    f.tables.doc_versions.push(
      { id: 1, doc_id: "d1", body: "a", created_at: "2026-01-01", actor: "user", kind: "manual", author: "me" },
      { id: 2, doc_id: "d1", body: "b", created_at: "2026-01-02", actor: "agent", kind: "turn", author: "Opus" },
      { id: 4, doc_id: "d1", body: "b2", created_at: "2026-01-02", actor: "user", kind: "manual", author: "me" }, // same created_at as id 2
      { id: 3, doc_id: "d2", body: "c", created_at: "2026-01-03", actor: "user", kind: "manual", author: "x" },
    );
    const s = new SupabaseDocumentStore(f.db, "d1");
    expect((await s.listVersions(10)).map((v) => v.id)).toEqual([4, 2, 1]); // d1 only; created_at desc, then id desc
    expect((await s.listVersions(1)).map((v) => v.id)).toEqual([4]); // limit honored
  });

  it("getVersion returns a version's body scoped to the doc; null when absent or another doc's", async () => {
    const f = makeFakeSupabase();
    f.tables.doc_versions.push({ id: 7, doc_id: "d1", body: "hello" }, { id: 8, doc_id: "other", body: "nope" });
    const s = new SupabaseDocumentStore(f.db, "d1");
    expect(await s.getVersion(7)).toBe("hello");
    expect(await s.getVersion(8)).toBeNull(); // belongs to another doc
    expect(await s.getVersion(999)).toBeNull();
  });
});

/** A client whose every terminal returns a Postgres error — to cover the throw paths. */
function erroringDb(): SupabaseClient {
  const fail = { data: null, error: { message: "boom" } };
  const q: Record<string, unknown> = {};
  for (const m of ["insert", "select", "eq", "gt", "update", "upsert", "order", "limit"]) q[m] = () => q;
  q.single = () => Promise.resolve(fail);
  q.maybeSingle = () => Promise.resolve(fail);
  q.then = (res: (v: unknown) => unknown) => Promise.resolve(fail).then(res);
  return { from: () => q } as unknown as SupabaseClient;
}

describe("SupabaseControlChannel error + presence paths", () => {
  const ch = () => new SupabaseControlChannel(erroringDb(), "d", "agent");
  it("surfaces a Postgres error from every method", async () => {
    await expect(ch().append({ actor: "user", type: "turn_ended" })).rejects.toThrow(/append failed: boom/);
    await expect(ch().readSince(0)).rejects.toThrow(/readSince failed: boom/);
    await expect(ch().getCursor()).rejects.toThrow(/getCursor failed: boom/);
    await expect(ch().setCursor(1)).rejects.toThrow(/setCursor failed: boom/);
    await expect(ch().claimLock("t")).rejects.toThrow(/claimLock failed: boom/);
    await expect(ch().isSuperseded("t")).rejects.toThrow(/isSuperseded failed: boom/);
    await expect(ch().presence()).rejects.toThrow(/presence failed: boom/);
  });

  it("presence: false with no heartbeat, true within TTL, false when stale", async () => {
    const f = makeFakeSupabase();
    const c = new SupabaseControlChannel(f.db, "d", "agent");
    expect(await c.presence()).toBe(false);
    f.tables.editor_presence.push({ doc_id: "d", last_seen: new Date().toISOString() });
    expect(await c.presence()).toBe(true);
    f.tables.editor_presence[0]!.last_seen = new Date(Date.now() - 60_000).toISOString();
    expect(await c.presence()).toBe(false);
  });

  it("getCursor returns 0 when the stored seq is absent/non-numeric", async () => {
    const f = makeFakeSupabase();
    f.tables.cursors.push({ doc_id: "d", consumer_id: "agent" }); // row exists, no seq
    expect(await new SupabaseControlChannel(f.db, "d", "agent").getCursor()).toBe(0);
  });
});

describe("SupabaseDocumentStore error paths", () => {
  const store = () => new SupabaseDocumentStore(erroringDb(), "d");
  it("surfaces a Postgres error from reads, writes, and backup", async () => {
    await expect(store().loadDoc()).rejects.toThrow(/read body failed: boom/);
    await expect(store().getCanonical()).rejects.toThrow(/read canonical failed: boom/);
    await expect(store().saveDoc("x")).rejects.toThrow(/update failed: boom/);
    await expect(store().backup("x")).rejects.toThrow(/backup failed: boom/);
  });
});

describe("createSupabaseBackend", () => {
  afterEach(() => vi.clearAllMocks());
  it("wires a channel + store onto a created client", async () => {
    const { createSupabaseBackend } = await import("../src/client");
    const { createClient } = await import("@supabase/supabase-js");
    const backend = createSupabaseBackend({ url: "https://x.supabase.co", key: "anon", docId: "doc-9", consumerId: "editor" });
    expect(createClient).toHaveBeenCalledWith("https://x.supabase.co", "anon");
    expect(backend.channel).toBeInstanceOf(SupabaseControlChannel);
    expect(backend.store).toBeInstanceOf(SupabaseDocumentStore);
  });
});
