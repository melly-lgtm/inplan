// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs the SAME backend contract against a live Supabase, proving the adapter is
// a drop-in for the in-process reference backend. Gated on env so the default
// `npm test` (no Supabase) skips it.
//
// To run:
//   supabase start && supabase db reset            # applies supabase/migrations
//   export SUPABASE_URL=...   SUPABASE_SERVICE_ROLE_KEY=...   # from `supabase status`
//   npm test
//
// The service-role key is used so the harness can provision fresh orgs/documents
// (bypassing RLS); RLS itself is exercised separately in M4.1.

import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, it } from "vitest";
import { SupabaseControlChannel, SupabaseDocumentStore } from "../src/index";
import { runControlChannelContract, runDocumentStoreContract } from "./contract";

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const env = url && key ? { url, key } : null;

if (env) {
  describe("live Supabase backend", () => {
    const db = createClient(env.url, env.key, { auth: { persistSession: false } });
    let n = 0;
    const createdOrgs: string[] = [];

    // Each contract case gets its own document (and parent org) so cases are isolated.
    async function freshDocId(): Promise<string> {
      const { data: org, error: oe } = await db
        .from("orgs")
        .insert({ name: `contract-${n++}` })
        .select("id")
        .single();
      if (oe) throw new Error(`org insert failed: ${oe.message}`);
      const orgId = (org as { id: string }).id;
      createdOrgs.push(orgId);
      const { data: doc, error: de } = await db
        .from("documents")
        .insert({ org_id: orgId })
        .select("id")
        .single();
      if (de) throw new Error(`document insert failed: ${de.message}`);
      return (doc as { id: string }).id;
    }

    afterAll(async () => {
      for (const id of createdOrgs) await db.from("orgs").delete().eq("id", id);
    });

    runControlChannelContract("SupabaseControlChannel", async () => new SupabaseControlChannel(db, await freshDocId()));
    runDocumentStoreContract("SupabaseDocumentStore", async () => new SupabaseDocumentStore(db, await freshDocId()));
  });
} else {
  describe.skip("live Supabase backend (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY to run)", () => {
    it("skipped — no Supabase env", () => {});
  });
}
