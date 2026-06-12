// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentStore, VersionMeta } from "@inplan/core";

/** A `documents` column that holds free text (see db/schema.sql). */
type DocColumn = "body" | "canonical" | "proposed";

/** A `doc_versions` checkpoint's metadata (no body) — for a history list. */
export interface VersionSummary {
  id: number;
  created_at: string;
  actor: string | null;
  kind: string | null;
  author: string | null;
}

/**
 * Supabase-backed {@link DocumentStore}: the working document and its derived
 * versions for one row of the `documents` table, with autosave checkpoints in
 * `doc_versions`. The desktop edition reads/writes sidecar files; this reads and
 * writes Postgres columns.
 *
 * In M4.3 the live `body` is materialized from the live collaboration store; until then it is the
 * single source of truth and this store is sufficient for the M4.2 (single active
 * editor) path.
 */
export class SupabaseDocumentStore implements DocumentStore {
  constructor(
    private readonly db: SupabaseClient,
    private readonly docId: string,
  ) {}

  async loadDoc(): Promise<string> {
    return (await this.readColumn("body")) ?? "";
  }

  async saveDoc(content: string): Promise<void> {
    await this.writeColumns({ body: content });
  }

  async getCanonical(): Promise<string | null> {
    return this.readColumn("canonical");
  }

  async setCanonical(content: string): Promise<void> {
    await this.writeColumns({ canonical: content });
  }

  async getProposed(): Promise<string | null> {
    return this.readColumn("proposed");
  }

  async setProposed(content: string): Promise<void> {
    await this.writeColumns({ proposed: content });
  }

  async clearProposed(): Promise<void> {
    await this.writeColumns({ proposed: null });
  }

  async backup(content: string, meta?: VersionMeta): Promise<void> {
    // Dedup: skip a no-op snapshot whose body matches the most recent version (keeps history from
    // churning on repeated saves/turns that didn't change the body). Best-effort — if the precheck
    // read fails, proceed to insert anyway rather than block the backup.
    const { data: latest } = await this.db
      .from("doc_versions")
      .select("body")
      .eq("doc_id", this.docId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // tie-break: id is monotonic, so "latest" is deterministic
      .limit(1)
      .maybeSingle();
    if ((latest as { body?: string } | null)?.body === content) return;
    // actor/kind/author are additive (doc_version_history migration); only send what's provided.
    const row: Record<string, unknown> = { doc_id: this.docId, body: content };
    if (meta?.actor) row.actor = meta.actor;
    if (meta?.kind) row.kind = meta.kind;
    if (meta?.author) row.author = meta.author;
    const { error } = await this.db.from("doc_versions").insert(row);
    if (error) throw new Error(`backup failed: ${error.message}`);
  }

  /** Recent version checkpoints (newest first), metadata only — for a history list. */
  async listVersions(limit = 50): Promise<VersionSummary[]> {
    const { data, error } = await this.db
      .from("doc_versions")
      .select("id, created_at, actor, kind, author")
      .eq("doc_id", this.docId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }) // deterministic newest-first even when created_at ties
      .limit(limit);
    if (error) throw new Error(`listVersions failed: ${error.message}`);
    return (data ?? []) as VersionSummary[];
  }

  /** The body of one version (scoped to this doc), or null if it no longer exists. */
  async getVersion(id: number): Promise<string | null> {
    const { data, error } = await this.db.from("doc_versions").select("body").eq("id", id).eq("doc_id", this.docId).maybeSingle();
    if (error) throw new Error(`getVersion failed: ${error.message}`);
    const body = (data as { body?: string } | null)?.body;
    return typeof body === "string" ? body : null;
  }

  private async readColumn(name: DocColumn): Promise<string | null> {
    const { data, error } = await this.db.from("documents").select(name).eq("id", this.docId).maybeSingle();
    if (error) throw new Error(`read ${name} failed: ${error.message}`);
    const value = (data as Record<string, unknown> | null)?.[name];
    return typeof value === "string" ? value : null;
  }

  private async writeColumns(patch: Partial<Record<DocColumn, string | null>>): Promise<void> {
    const { error } = await this.db
      .from("documents")
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq("id", this.docId);
    if (error) throw new Error(`update failed: ${error.message}`);
  }
}
