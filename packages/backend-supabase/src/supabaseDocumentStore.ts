// SPDX-License-Identifier: AGPL-3.0-or-later

import type { SupabaseClient } from "@supabase/supabase-js";
import type { DocumentStore, ProposalInput, ProposalRow, ProposalState, VersionMeta } from "@inplan/core";
import { mintProposalId } from "@inplan/core";

/** A `documents` column that holds free text (see db/schema.sql). */
type DocColumn = "body" | "canonical";

/** Who is parking proposals through this store — identifies "my" rows (proposals v1). */
export interface ProposerIdentity {
  kind: "user" | "agent";
  /** auth.uid() for kind "user" (RLS also enforces it); an agent name for kind "agent". */
  userId?: string;
  /** Stable per-machine/client id (persisted by the caller). */
  clientId: string;
}

/** The `proposals` table row shape (see the proposals-v1 migration in the cloud repo). */
interface DbProposalRow {
  id: string;
  content: string;
  base_hash: string;
  base_content: string;
  state: ProposalState;
  created_at: string;
  decided_at: string | null;
}

const toRow = (r: DbProposalRow): ProposalRow => ({
  id: r.id,
  content: r.content,
  baseHash: r.base_hash,
  baseContent: r.base_content,
  state: r.state,
  createdAt: r.created_at,
  ...(r.decided_at ? { decidedAt: r.decided_at } : {}),
});

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
    /** REQUIRED — no default. "My pending proposal" must mean exactly one proposer: a defaulted
     *  identity without a userId matched every user-kind row, and on the service-role path (which
     *  bypasses RLS) that let one caller read, supersede, or withdraw another's pending proposal. */
    private readonly proposer: ProposerIdentity,
  ) {}

  /** Filter for the caller's own proposal rows. */
  private mineFilter() {
    const f: Record<string, string> = { proposer_kind: this.proposer.kind, client_id: this.proposer.clientId };
    if (this.proposer.userId !== undefined) f.proposer_user_id = this.proposer.userId;
    return f;
  }

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

  async createProposal(input: ProposalInput): Promise<{ id: string }> {
    // Identical content with no explicit id re-parks the SAME proposal (a retry, not a
    // successor) — same rule as the memory/fs backends, pinned by the shared contract.
    const reuse = input.id ? null : await this.myPendingProposal();
    const id = input.id ?? (reuse && reuse.content === input.content ? reuse.id : mintProposalId());
    // Look BEFORE any mutation: a stale retry of a DECIDED id must return untouched — running
    // the supersede first would let it displace the caller's newer live proposal. Terminal
    // states are immutable; the decision wins every race below.
    const existing = await this.getProposal(id);
    if (existing) {
      if (existing.state !== "pending") return { id };
      // Converge-if-pending, scoped to the caller's own rows (defense-in-depth beside RLS: the
      // service-role path bypasses RLS, and an id must never let one proposer rewrite another's
      // pending content). Zero rows = decided or not ours in the meantime — converge as a no-op.
      const { error } = await this.db
        .from("proposals")
        .update({ content: input.content, base_hash: input.baseHash, base_content: input.baseContent })
        .match({ doc_id: this.docId, id, state: "pending", ...this.mineFilter() });
      if (error) throw new Error(`createProposal failed: ${error.message}`);
      return { id };
    }
    // New id: supersede the caller's OWN previous pending row, then insert. Sequential statements
    // rather than a transaction — a proposer only races itself (single live waiter per client),
    // and the phase-B partial unique index (one pending per proposer per doc) backstops the rest:
    // a concurrent insert surfaces as a unique violation, handled as convergence below.
    const { error: supersedeErr } = await this.db
      .from("proposals")
      .update({ state: "superseded" })
      .match({ doc_id: this.docId, state: "pending", ...this.mineFilter() })
      .neq("id", id);
    if (supersedeErr) throw new Error(`createProposal failed: ${supersedeErr.message}`);
    const { error } = await this.db.from("proposals").insert({
      id,
      doc_id: this.docId,
      proposer_kind: this.proposer.kind,
      proposer_user_id: this.proposer.userId ?? null,
      client_id: this.proposer.clientId,
      content: input.content,
      base_hash: input.baseHash,
      base_content: input.baseContent,
      state: "pending",
    });
    if (error) {
      if ((error as { code?: string }).code === "23505") {
        // Unique violation = another writer of OURS got there first (the id, or the one-pending-
        // per-proposer index). CONVERGE PROPERLY: re-run the pending-scoped update so the caller's
        // content actually lands (returning bare {id} would silently drop it), tolerating a row
        // that went terminal in the same window — the decision wins.
        const { error: convergeErr } = await this.db
          .from("proposals")
          .update({ content: input.content, base_hash: input.baseHash, base_content: input.baseContent })
          .match({ doc_id: this.docId, id, state: "pending", ...this.mineFilter() });
        if (!convergeErr && (await this.getProposal(id))) return { id };
      }
      throw new Error(`createProposal failed: ${error.message}`);
    }
    return { id };
  }

  async myPendingProposal(): Promise<ProposalRow | null> {
    const { data, error } = await this.db
      .from("proposals")
      .select("id, content, base_hash, base_content, state, created_at, decided_at")
      .match({ doc_id: this.docId, state: "pending", ...this.mineFilter() })
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`myPendingProposal failed: ${error.message}`);
    return data ? toRow(data as DbProposalRow) : null;
  }

  async getProposal(id: string): Promise<ProposalRow | null> {
    const { data, error } = await this.db
      .from("proposals")
      .select("id, content, base_hash, base_content, state, created_at, decided_at")
      .match({ doc_id: this.docId, id })
      .maybeSingle();
    if (error) throw new Error(`getProposal failed: ${error.message}`);
    return data ? toRow(data as DbProposalRow) : null;
  }

  async withdrawProposal(id: string): Promise<void> {
    // State-guarded: only a pending row moves; a raced decision wins (terminal is immutable).
    const { error } = await this.db.from("proposals").update({ state: "withdrawn" }).match({ doc_id: this.docId, id, state: "pending", ...this.mineFilter() });
    if (error) throw new Error(`withdrawProposal failed: ${error.message}`);
  }

  async decideProposal(id: string, state: "accepted" | "partially_accepted" | "rejected"): Promise<void> {
    const { error } = await this.db
      .from("proposals")
      .update({ state, decided_at: new Date().toISOString() })
      .match({ doc_id: this.docId, id, state: "pending" });
    if (error) throw new Error(`decideProposal failed: ${error.message}`);
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
