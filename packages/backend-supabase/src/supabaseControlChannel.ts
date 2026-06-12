// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SupabaseClient } from "@supabase/supabase-js";
import type { AppendOptions, ControlChannel, LogEntry, NewLogEntry, WaitToken } from "@inplan/core";

/** How long an editor heartbeat counts as "present" before it is considered stale. */
const PRESENCE_TTL_MS = 15_000;

/** Shape of a row in the `events` table (see db/schema.sql). */
interface EventRow {
  seq: number;
  ts: string;
  actor: "user" | "agent";
  type: string;
  payload: unknown;
}

/**
 * Supabase-backed {@link ControlChannel}: the append-only protocol log + audit
 * trail + single agent-run arbiter for one document. The desktop edition wraps a
 * JSONL file + a file watcher + a `.waitlock`; this wraps the `events` table, a
 * Realtime subscription, the `cursors`/`locks` tables, and a presence heartbeat.
 *
 * Untyped `SupabaseClient` is used deliberately: generated DB types are a M4.1
 * follow-up, so query results are loosely typed here and validated by the shared
 * contract suite.
 */
export class SupabaseControlChannel implements ControlChannel {
  constructor(
    private readonly db: SupabaseClient,
    private readonly docId: string,
    /** Identifies this consumer for the persisted read cursor (e.g. "agent" / "editor"). */
    private readonly consumerId: string = "default",
  ) {}

  async append(event: NewLogEntry, opts?: AppendOptions): Promise<LogEntry> {
    const { data, error } = await this.db
      .from("events")
      .insert({
        doc_id: this.docId,
        actor: event.actor,
        type: event.type,
        payload: event.payload ?? null,
        // Only set user_id when attributed — older deployments may not have the column, and an
        // unattributed (agent-internal) event leaves it null.
        ...(opts?.userId ? { user_id: opts.userId } : {}),
      })
      .select("seq, ts, actor, type, payload")
      .single();
    if (error) throw new Error(`append failed: ${error.message}`);
    return rowToEntry(data as EventRow);
  }

  async readSince(cursor: number): Promise<{ entries: LogEntry[]; cursor: number }> {
    const { data, error } = await this.db
      .from("events")
      .select("seq, ts, actor, type, payload")
      .eq("doc_id", this.docId)
      .gt("seq", cursor)
      .order("seq", { ascending: true });
    if (error) throw new Error(`readSince failed: ${error.message}`);
    const rows = (data ?? []) as EventRow[];
    const entries = rows.map(rowToEntry);
    const last = entries[entries.length - 1];
    return { entries, cursor: last ? last.seq : cursor };
  }

  subscribe(onChange: () => void): () => void {
    const channel = this.db
      .channel(`events:${this.docId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "events", filter: `doc_id=eq.${this.docId}` },
        () => onChange(),
      )
      .subscribe();
    return () => {
      void this.db.removeChannel(channel);
    };
  }

  async getCursor(): Promise<number> {
    const { data, error } = await this.db
      .from("cursors")
      .select("seq")
      .eq("doc_id", this.docId)
      .eq("consumer_id", this.consumerId)
      .maybeSingle();
    if (error) throw new Error(`getCursor failed: ${error.message}`);
    const seq = (data as { seq?: number } | null)?.seq;
    return typeof seq === "number" ? seq : 0;
  }

  async setCursor(seq: number): Promise<void> {
    const { error } = await this.db
      .from("cursors")
      .upsert({ doc_id: this.docId, consumer_id: this.consumerId, seq }, { onConflict: "doc_id,consumer_id" });
    if (error) throw new Error(`setCursor failed: ${error.message}`);
  }

  async claimLock(token: WaitToken): Promise<void> {
    const { error } = await this.db
      .from("locks")
      .upsert({ doc_id: this.docId, token, claimed_at: new Date().toISOString() }, { onConflict: "doc_id" });
    if (error) throw new Error(`claimLock failed: ${error.message}`);
  }

  async isSuperseded(token: WaitToken): Promise<boolean> {
    const { data, error } = await this.db
      .from("locks")
      .select("token")
      .eq("doc_id", this.docId)
      .maybeSingle();
    if (error) throw new Error(`isSuperseded failed: ${error.message}`);
    const current = (data as { token?: string } | null)?.token;
    // No lock row -> not superseded; a different token holds the lock -> superseded.
    return current != null && current !== token;
  }

  async presence(): Promise<boolean> {
    // TODO(M4.3): derive from live/Realtime presence on the doc's collaboration room.
    // Interim: an editor heartbeat row fresher than PRESENCE_TTL_MS.
    const { data, error } = await this.db
      .from("editor_presence")
      .select("last_seen")
      .eq("doc_id", this.docId)
      .maybeSingle();
    if (error) throw new Error(`presence failed: ${error.message}`);
    const lastSeen = (data as { last_seen?: string } | null)?.last_seen;
    if (!lastSeen) return false;
    return Date.now() - new Date(lastSeen).getTime() < PRESENCE_TTL_MS;
  }
}

function rowToEntry(r: EventRow): LogEntry {
  return { seq: r.seq, ts: r.ts, actor: r.actor, type: r.type, payload: r.payload ?? undefined };
}
