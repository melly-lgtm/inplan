// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan upload` must migrate pre-existing LOCAL images (pasted while the doc was still local, so
// they're relative links into a sibling `.assets/` folder) into the cloud `doc-images` bucket and
// rewrite the body's links — otherwise a doc promoted to the cloud arrives with links into a folder
// that has no counterpart there. Covers: a doc with a local image (migrated, both the local file
// and the cloud row end up rewritten), a doc with no images (storage untouched), an already-absolute
// image URL (left alone), and a dangling local link (left alone, no crash) — all over a mocked
// authed session, no network.

import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let rpcResult: { data: unknown; error: unknown } = { data: { status: "created", id: "doc-new" }, error: null };
let memberships: { data: unknown; error: unknown } = { data: [{ org_id: "org-1", orgs: { slug: "acme", name: "Acme" } }], error: null };
let existingDocId: string | null = null; // the "exists" (re-upload) path's lookup result
const rpc = vi.fn(async (_name: string, _params: Record<string, unknown>) => rpcResult);
let uploadResult: { error: { status: number; message: string } | null } = { error: null };
const upload = vi.fn(async (_path: string, _bytes: unknown, _opts: unknown) => uploadResult);
const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.test/doc-images/${path}` } }));
let updateError: { message: string } | null = null;
const update = vi.fn((_patch: Record<string, unknown>) => ({ eq: () => Promise.resolve({ error: updateError }) }));

function fakeDb() {
  const membershipsQ: Record<string, unknown> = {};
  membershipsQ.select = () => membershipsQ;
  membershipsQ.in = () => Promise.resolve(memberships);

  const documentsQ: Record<string, unknown> = {};
  documentsQ.select = () => documentsQ;
  documentsQ.eq = () => documentsQ;
  documentsQ.maybeSingle = () => Promise.resolve({ data: existingDocId ? { id: existingDocId } : null, error: null });
  documentsQ.update = update;

  return {
    from: (table: string) => (table === "memberships" ? membershipsQ : documentsQ),
    rpc,
    storage: { from: () => ({ upload, getPublicUrl }) },
  };
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
let errOut: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-upload-migrate-"));
  process.env.INPLAN_SIDECAR_DIR = join(home, "sidecars");
  file = join(home, "PLAN.md");
  out = [];
  errOut = [];
  exitCode = null;
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    errOut.push(String(s));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${code}`);
  }) as never);
  rpc.mockClear();
  upload.mockClear();
  getPublicUrl.mockClear();
  update.mockClear();
  rpcResult = { data: { status: "created", id: "doc-new" }, error: null };
  memberships = { data: [{ org_id: "org-1", orgs: { slug: "acme", name: "Acme" } }], error: null };
  uploadResult = { error: null };
  existingDocId = null;
  updateError = null;
});
afterEach(() => {
  delete process.env.INPLAN_SIDECAR_DIR;
  vi.restoreAllMocks();
});

const lastJson = () => JSON.parse(out.join("").trim().split("\n").pop()!);

describe("inplan upload → local image migration", () => {
  it("uploads a local relative image, rewrites the link in both the local file and the cloud row", async () => {
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    writeFileSync(join(home, "PLAN.assets", "image-1.png"), Buffer.from([1, 2, 3]));
    writeFileSync(file, "# My Plan\n\n![](<PLAN.assets/image-1.png>)\n");

    await doUpload(file, []);

    expect(upload).toHaveBeenCalledTimes(1);
    const [path] = upload.mock.calls[0]!;
    expect(path).toMatch(/^org-1\/doc-new\/image-\d{14}-[0-9a-f]{8}\.png$/);

    const url = `https://cdn.test/doc-images/${path}`;
    expect(readFileSync(file, "utf8")).toContain(`![](${url})`);
    expect(readFileSync(file, "utf8")).not.toContain("PLAN.assets");

    expect(update).toHaveBeenCalledWith(expect.objectContaining({ body: expect.stringContaining(url) }));
    expect(lastJson()).toMatchObject({ status: "uploaded", cloudDocId: "doc-new" });
  });

  it("a doc with no images never touches storage", async () => {
    writeFileSync(file, "# My Plan\n\njust text\n");
    await doUpload(file, []);
    expect(upload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(lastJson()).toMatchObject({ status: "uploaded" });
  });

  it("leaves an already-absolute image URL untouched", async () => {
    writeFileSync(file, "# My Plan\n\n![](https://example.com/pic.png)\n");
    await doUpload(file, []);
    expect(upload).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toContain("https://example.com/pic.png");
  });

  it("leaves a dangling local link untouched (no crash) when the referenced file is missing", async () => {
    writeFileSync(file, "# My Plan\n\n![](<PLAN.assets/missing.png>)\n");
    await doUpload(file, []);
    expect(upload).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toContain("PLAN.assets/missing.png");
    expect(lastJson()).toMatchObject({ status: "uploaded" });
  });

  it("a storage failure during migration doesn't fail the promote itself", async () => {
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    writeFileSync(join(home, "PLAN.assets", "image-1.png"), Buffer.from([1, 2, 3]));
    writeFileSync(file, "# My Plan\n\n![](<PLAN.assets/image-1.png>)\n");
    uploadResult = { error: { status: 500, message: "boom" } }; // a real (non-collision) failure — no retry

    await doUpload(file, []);
    expect(update).not.toHaveBeenCalled(); // nothing migrated → no cloud body rewrite
    expect(readFileSync(file, "utf8")).toContain("PLAN.assets/image-1.png"); // local link left as-is
    expect(lastJson()).toMatchObject({ status: "uploaded" }); // promote itself still succeeded
  });

  it("never reads or uploads a file outside the doc's own directory (path traversal)", async () => {
    // A sibling directory to `home` (the doc's own dir) — a `../` link must not escape into it.
    const outside = mkdtempSync(join(tmpdir(), "inplan-upload-migrate-outside-"));
    const secretFile = join(outside, "secret.png");
    writeFileSync(secretFile, Buffer.from("not actually yours"));
    const rel = relative(home, secretFile).replace(/\\/g, "/");
    expect(rel.startsWith("..")).toBe(true); // sanity: this really is outside the doc's dir
    writeFileSync(file, `# My Plan\n\n![](<${rel}>)\n`);

    await doUpload(file, []);
    expect(upload).not.toHaveBeenCalled(); // never read, never uploaded
    expect(readFileSync(file, "utf8")).toContain(rel); // link left untouched — not "fixed" into a URL
  });

  it("skips a local file whose extension isn't a recognized image type (no png fallback)", async () => {
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    writeFileSync(join(home, "PLAN.assets", "id_ed25519"), "not an image, definitely not");
    writeFileSync(file, "# My Plan\n\n![](<PLAN.assets/id_ed25519>)\n");

    await doUpload(file, []);
    expect(upload).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toContain("PLAN.assets/id_ed25519");
  });

  it("rewrites the URL, not parenthesized alt text, into the link", async () => {
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    writeFileSync(join(home, "PLAN.assets", "image-1.png"), Buffer.from([1, 2, 3]));
    writeFileSync(file, "# My Plan\n\n![a (x) b](<PLAN.assets/image-1.png>)\n");

    await doUpload(file, []);

    const [path] = upload.mock.calls[0]!;
    const url = `https://cdn.test/doc-images/${path}`;
    const rewritten = readFileSync(file, "utf8");
    expect(rewritten).toContain(`![a (x) b](${url})`); // alt text preserved verbatim, destination replaced
    expect(rewritten).not.toContain("PLAN.assets"); // the real destination didn't stay local
  });

  it("never writes documents.body on a re-upload of an already-existing doc, even with a local image", async () => {
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    writeFileSync(join(home, "PLAN.assets", "image-1.png"), Buffer.from([1, 2, 3]));
    writeFileSync(file, "# My Plan\n\n![](<PLAN.assets/image-1.png>)\n");
    rpcResult = { data: { status: "exists" }, error: null };
    existingDocId = "doc-existing";

    await doUpload(file, []);

    // Under the unified-Yjs model the collab hub is the sole writer of documents.body once a doc
    // exists — migrating (and so writing the body) here would race it and can clobber live edits.
    expect(upload).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect(readFileSync(file, "utf8")).toContain("PLAN.assets/image-1.png"); // left as-is, not "fixed"
    expect(lastJson()).toMatchObject({ status: "uploaded", cloudDocId: "doc-existing" });
  });

  it("leaves the local file untouched when the cloud write fails, so lastSyncedHash never lies", async () => {
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    writeFileSync(join(home, "PLAN.assets", "image-1.png"), Buffer.from([1, 2, 3]));
    const original = "# My Plan\n\n![](<PLAN.assets/image-1.png>)\n";
    writeFileSync(file, original);
    updateError = { message: "boom" }; // the image uploads fine; the cloud body write fails

    await doUpload(file, []);

    expect(upload).toHaveBeenCalledTimes(1); // the image itself did upload
    expect(update).toHaveBeenCalledTimes(1); // the cloud write was attempted (and failed)
    // Cloud-first ordering: since the cloud write failed, the local file must NOT have been
    // rewritten either — otherwise lastSyncedHash (computed from whatever's now on disk) would
    // match a body the cloud never actually received.
    expect(readFileSync(file, "utf8")).toBe(original);
  });

  it("migrates more than 6 same-second images without exhausting the retry budget", async () => {
    // Regression for the old scheme, where every image in the same second shared ONE base name
    // (`image-<second>`) and only n<=5 disambiguating retries existed — a 7th image in the same
    // second had nowhere left to go and stayed a dangling local link. Each upload now carries its
    // own unguessable suffix, so a same-second batch never depends on the retry loop at all.
    mkdirSync(join(home, "PLAN.assets"), { recursive: true });
    const n = 7;
    const lines = Array.from({ length: n }, (_, i) => {
      writeFileSync(join(home, "PLAN.assets", `image-${i}.png`), Buffer.from([i]));
      return `![](<PLAN.assets/image-${i}.png>)`;
    });
    writeFileSync(file, `# My Plan\n\n${lines.join("\n\n")}\n`);

    await doUpload(file, []);

    expect(upload).toHaveBeenCalledTimes(n);
    const paths = upload.mock.calls.map((c) => c[0] as string);
    expect(new Set(paths).size).toBe(n); // every image landed on a distinct path
    const rewritten = readFileSync(file, "utf8");
    expect(rewritten).not.toContain("PLAN.assets"); // none left dangling locally
  });
});
