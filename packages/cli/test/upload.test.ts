// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan upload` routes through the create_document RPC (the single source of truth for the
// active-doc cap + LRU eviction). Covers a normal create, the at-cap side-effect-free limit
// probe, the confirmed --evict-lru re-run, idempotent re-upload (exists → adopt the row), and
// a hard RPC failure — all over a mocked authed session, no network.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// authedSession → a fake supabase client; provenance is stubbed so the test doesn't depend on git.
let rpcResult: { data: unknown; error: unknown } = { data: { status: "created", id: "doc-new" }, error: null };
let memberships: { data: unknown; error: unknown } = { data: [{ org_id: "org-1", orgs: { slug: "acme", name: "Acme" } }], error: null };
let existingDoc: unknown = null;
const rpc = vi.fn(async () => rpcResult);

function fakeDb() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.in = () => Promise.resolve(memberships);
  q.eq = () => q;
  q.maybeSingle = () => Promise.resolve({ data: existingDoc, error: null });
  return { from: () => q, rpc };
}

vi.mock("../src/cliAuth", () => ({
  authedSession: vi.fn(async () => ({ db: fakeDb(), session: { user: { id: "user-1" } } })),
}));
vi.mock("../src/provenance", () => ({
  gitProvenance: () => ({ repo: "acme/plan", path: "docs/PLAN.md" }),
}));

import { doUpload } from "../src/cli";

let home: string;
let file: string;
let out: string[];
let exitCode: number | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-upload-"));
  process.env.INPLAN_SIDECAR_DIR = join(home, "sidecars");
  file = join(home, "PLAN.md");
  writeFileSync(file, "# My Plan\n\nbody\n");
  out = [];
  exitCode = null;
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${code}`); // halt the flow like the real process.exit
  }) as never);
  rpc.mockClear();
  rpcResult = { data: { status: "created", id: "doc-new" }, error: null };
  memberships = { data: [{ org_id: "org-1", orgs: { slug: "acme", name: "Acme" } }], error: null };
  existingDoc = null;
});
afterEach(() => {
  delete process.env.INPLAN_SIDECAR_DIR;
  vi.restoreAllMocks();
});

const lastJson = () => JSON.parse(out.join("").trim().split("\n").pop()!);

describe("inplan upload → create_document RPC", () => {
  it("a normal create calls the RPC (evict_lru false) and reports the uploaded doc + locator", async () => {
    await doUpload(file, []);
    expect(rpc).toHaveBeenCalledWith("create_document", expect.objectContaining({ p_org: "org-1", p_repo: "acme/plan", p_path: "docs/PLAN.md", p_title: "My Plan", p_evict_lru: false, p_draft_pending: false }));
    expect(lastJson()).toEqual({ status: "uploaded", cloudDocId: "doc-new", locator: { org: "acme", repo: "acme/plan", path: "docs/PLAN.md" } });
  });

  it("at the cap (no --evict-lru) emits {status:'limit', lru} and creates/deactivates NOTHING", async () => {
    rpcResult = { data: { status: "limit", limit: 1, lru_id: "doc-old", lru_title: "Old Plan" }, error: null };
    await doUpload(file, []);
    expect(rpc).toHaveBeenCalledTimes(1); // a single side-effect-free probe
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_evict_lru: false });
    expect(lastJson()).toEqual({ status: "limit", limit: 1, lru: { id: "doc-old", title: "Old Plan" } });
  });

  it("--evict-lru passes p_evict_lru=true so the confirmed run deactivates the LRU then creates", async () => {
    await doUpload(file, ["--evict-lru"]);
    expect(rpc.mock.calls[0]![1]).toMatchObject({ p_evict_lru: true });
    expect(lastJson()).toMatchObject({ status: "uploaded", cloudDocId: "doc-new" });
  });

  it("a re-upload (exists) adopts the existing row so it's idempotent, not an error", async () => {
    rpcResult = { data: { status: "exists" }, error: null };
    existingDoc = { id: "doc-existing" };
    await doUpload(file, []);
    expect(lastJson()).toMatchObject({ status: "uploaded", cloudDocId: "doc-existing" });
  });

  it("exits non-zero on a hard RPC failure (no false 'uploaded')", async () => {
    rpcResult = { data: null, error: { message: "boom" } };
    await expect(doUpload(file, [])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(out.join("")).not.toContain("uploaded");
  });
});
