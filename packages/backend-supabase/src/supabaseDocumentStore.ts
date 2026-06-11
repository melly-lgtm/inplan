// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentStore } from "@inplan/core";

/** A `documents` column that holds free text (see db/schema.sql). */
type DocColumn = "body" | "canonical" | "proposed";

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

  async backup(content: string): Promise<void> {
    const { error } = await this.db.from("doc_versions").insert({ doc_id: this.docId, body: content });
    if (error) throw new Error(`backup failed: ${error.message}`);
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
