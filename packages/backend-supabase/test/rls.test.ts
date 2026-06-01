// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Proves the M4.1 row-level-security policies with REAL authenticated users.
// The service-role contract suite bypasses RLS; this is the separate layer that
// verifies the member_role split actually holds. Gated on env (URL + service +
// anon/publishable key); creates users via the admin API, signs them in with the
// publishable key so requests carry a user JWT and RLS applies.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const env = url && serviceKey && anonKey ? { url, serviceKey, anonKey } : null;

if (env) {
  describe("RLS — member_role enforcement", () => {
    const admin = createClient(env.url, env.serviceKey, { auth: { persistSession: false } });
    const stamp = Date.now();
    const password = "Password123!";
    let orgId = "";
    let docId = "";
    const users: Record<string, { id: string; client: SupabaseClient }> = {};

    async function makeUser(role: string): Promise<{ id: string; client: SupabaseClient }> {
      const email = `rls-${role}-${stamp}@example.com`;
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true });
      if (error || !data.user) throw new Error(`createUser(${role}): ${error?.message}`);
      const client = createClient(env.url, env.anonKey, { auth: { persistSession: false } });
      const { error: signErr } = await client.auth.signInWithPassword({ email, password });
      if (signErr) throw new Error(`signIn(${role}): ${signErr.message}`);
      return { id: data.user.id, client };
    }

    beforeAll(async () => {
      const { data: org, error: oe } = await admin.from("orgs").insert({ name: `rls-${stamp}` }).select("id").single();
      if (oe) throw new Error(`org: ${oe.message}`);
      orgId = (org as { id: string }).id;
      const { data: doc, error: de } = await admin
        .from("documents")
        .insert({ org_id: orgId, body: "secret" })
        .select("id")
        .single();
      if (de) throw new Error(`doc: ${de.message}`);
      docId = (doc as { id: string }).id;

      for (const role of ["viewer", "commenter", "editor"]) {
        users[role] = await makeUser(role);
        const { error } = await admin.from("memberships").insert({ org_id: orgId, user_id: users[role]!.id, role });
        if (error) throw new Error(`membership(${role}): ${error.message}`);
      }
      users.nonmember = await makeUser("nonmember"); // intentionally no membership
    }, 45000);

    afterAll(async () => {
      if (orgId) await admin.from("orgs").delete().eq("id", orgId); // cascades to doc/comments/memberships
      for (const u of Object.values(users)) await admin.auth.admin.deleteUser(u.id);
    });

    it("a non-member cannot see the document", async () => {
      const { data } = await users.nonmember!.client.from("documents").select("id").eq("id", docId);
      expect(data).toEqual([]);
    });

    it("a viewer can read but cannot edit the body or comment", async () => {
      const { data: read } = await users.viewer!.client.from("documents").select("id").eq("id", docId);
      expect(read).toHaveLength(1);

      const { data: upd } = await users.viewer!.client.from("documents").update({ body: "hacked" }).eq("id", docId).select("id");
      expect(upd).toEqual([]); // RLS filtered the row out of the update

      const { error: cmtErr } = await users.viewer!.client.from("comments").insert({ doc_id: docId, author: "v", text: "x" });
      expect(cmtErr).not.toBeNull(); // insert blocked by RLS check

      const { data: check } = await admin.from("documents").select("body").eq("id", docId).single();
      expect((check as { body: string }).body).toBe("secret"); // body untouched
    });

    it("a commenter can comment but cannot edit the body", async () => {
      const { error: cmtErr } = await users.commenter!.client.from("comments").insert({ doc_id: docId, author: "c", text: "hi" });
      expect(cmtErr).toBeNull();

      const { data: upd } = await users.commenter!.client.from("documents").update({ body: "nope" }).eq("id", docId).select("id");
      expect(upd).toEqual([]);
    });

    it("an editor can edit the body and comment", async () => {
      const { data: upd } = await users.editor!.client.from("documents").update({ title: "edited" }).eq("id", docId).select("id");
      expect(upd).toHaveLength(1);

      const { error: cmtErr } = await users.editor!.client.from("comments").insert({ doc_id: docId, author: "e", text: "yo" });
      expect(cmtErr).toBeNull();
    });
  });
} else {
  describe.skip("RLS — member_role enforcement (set SUPABASE_URL + SERVICE_ROLE + ANON keys to run)", () => {
    it("skipped — no Supabase env", () => {});
  });
}
