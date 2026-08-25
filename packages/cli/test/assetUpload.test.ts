// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan asset-upload` is what the desktop app shells out to when it's live-connected to a
// cloud doc (Collaborate on Cloud): it reads bytes from a temp file, resolves the doc's org via
// the `documents` table, and uploads to the `doc-images` bucket — mirroring the cloud web app's
// own saveAsset (same bucket, same org/doc path scheme, same 409-collision retry). Covers a
// non-cloud doc, a missing --bytes-file, a logged-out session, a normal upload, a collision retry,
// a hard storage failure, and the unknown-extension → png fallback — all over a mocked authed
// session, no network.

import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { docPaths, writeStatus } from "@inplan/core/node";

let uploadResult: { error: { status: number; message: string } | null } = { error: null };
let orgLookup: { data: unknown; error: unknown } = { data: { org_id: "org-1" }, error: null };
let sessionPresent = true;
const upload = vi.fn(async (_path: string, _bytes: unknown, _opts: unknown) => uploadResult);
const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.test/doc-images/${path}` } }));

// The `doc_assets` content registry (sha256+ext → object_path) that lets a repeat paste of the
// same bytes reuse the object already in the bucket. `assetRegistryError` stands in for a cloud
// without the table, which must fail open to a normal upload.
let assetRegistry: Map<string, string>;
let assetRegistryError: { message: string } | null = null;
let assetInserts: Array<Record<string, unknown>>;

function docAssetsQuery() {
  const seen: Record<string, unknown> = {};
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = (column: string, value: unknown) => {
    seen[column] = value;
    return q;
  };
  q.maybeSingle = () => {
    if (assetRegistryError) return Promise.resolve({ data: null, error: assetRegistryError });
    const hit = assetRegistry.get(`${seen.sha256}|${seen.ext}`);
    return Promise.resolve({ data: hit ? { object_path: hit } : null, error: null });
  };
  q.insert = (row: Record<string, unknown>) => {
    assetInserts.push(row);
    assetRegistry.set(`${row.sha256}|${row.ext}`, String(row.object_path));
    return Promise.resolve({ data: null, error: null });
  };
  return q;
}

function fakeDb() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = () => Promise.resolve(orgLookup);
  return {
    from: (table: string) => (table === "doc_assets" ? docAssetsQuery() : q),
    storage: { from: () => ({ upload, getPublicUrl }) },
  };
}

vi.mock("../src/cliAuth", () => ({
  authedSession: vi.fn(async () => (sessionPresent ? { db: fakeDb(), session: { user: { id: "user-1" } } } : null)),
}));

import { doAssetUpload, doAssetUploadForDoc, main } from "../src/cli";

let home: string;
let file: string;
let bytesFile: string;
let out: string[];
let stderr: string[];
let exitCode: number | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-asset-upload-"));
  process.env.INPLAN_SIDECAR_DIR = join(home, "sidecars");
  file = join(home, "PLAN.md");
  writeFileSync(file, "# My Plan\n\nbody\n");
  bytesFile = join(home, "bytes.bin");
  writeFileSync(bytesFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  out = [];
  stderr = [];
  assetRegistry = new Map();
  assetRegistryError = null;
  assetInserts = [];
  exitCode = null;
  vi.spyOn(process.stdout, "write").mockImplementation((s: string | Uint8Array) => {
    out.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s: string | Uint8Array) => {
    stderr.push(String(s));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code ?? 0;
    throw new Error(`exit:${code}`); // halt the flow like the real process.exit
  }) as never);
  upload.mockClear();
  getPublicUrl.mockClear();
  uploadResult = { error: null };
  orgLookup = { data: { org_id: "org-1" }, error: null };
  sessionPresent = true;
});
afterEach(() => {
  delete process.env.INPLAN_SIDECAR_DIR;
  vi.restoreAllMocks();
});

const lastJson = () => JSON.parse(out.join("").trim().split("\n").pop()!);

describe("inplan asset-upload → doc-images bucket", () => {
  it("rejects a doc that isn't cloud-connected, and points at the --remote form", async () => {
    await expect(doAssetUpload(file, ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(upload).not.toHaveBeenCalled();
    expect(stderr.join("")).toContain("--remote");
  });

  it("rejects a missing --bytes-file", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    await expect(doAssetUpload(file, [])).rejects.toThrow(/exit:64/);
    expect(exitCode).toBe(64);
  });

  it("exits when not logged in", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    sessionPresent = false;
    await expect(doAssetUpload(file, ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
  });

  it("uploads to org/doc-scoped path and reports the public URL", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    await doAssetUpload(file, ["--bytes-file", bytesFile, "--ext", "png"]);
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, , opts] = upload.mock.calls[0]!;
    expect(path).toMatch(/^org-1\/doc-9\/image-\d{14}-[0-9a-f]{8}\.png$/);
    expect(opts).toEqual({ contentType: "image/png" });
    expect(lastJson()).toEqual({ status: "uploaded", relPath: `https://cdn.test/doc-images/${path}` });
  });

  it("falls back to png for an unrecognized extension", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    await doAssetUpload(file, ["--bytes-file", bytesFile, "--ext", "bmp"]);
    const [path, , opts] = upload.mock.calls[0]!;
    expect(path).toMatch(/\.png$/);
    expect(opts).toEqual({ contentType: "image/png" });
  });

  it("retries past a name collision (409) then succeeds", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    upload.mockImplementationOnce(async () => ({ error: { status: 409, message: "duplicate" } })).mockImplementationOnce(async () => ({ error: null }));
    await doAssetUpload(file, ["--bytes-file", bytesFile, "--ext", "png"]);
    expect(upload).toHaveBeenCalledTimes(2);
    // Each attempt carries its own unguessable suffix (not a sequential counter), so a retry
    // after a collision lands on a genuinely different path rather than a predictable "-1".
    expect(upload.mock.calls[1]![0]).toMatch(/^org-1\/doc-9\/image-\d{14}-[0-9a-f]{8}\.png$/);
    expect(upload.mock.calls[1]![0]).not.toBe(upload.mock.calls[0]![0]);
    expect(lastJson()).toMatchObject({ status: "uploaded" });
  });

  it("exits non-zero on a hard storage failure (not a collision)", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    uploadResult = { error: { status: 403, message: "forbidden" } };
    await expect(doAssetUpload(file, ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(upload).toHaveBeenCalledTimes(1); // no retry on a real failure
    expect(out.join("")).not.toContain("uploaded");
  });

  it("exits when the document's org can't be resolved", async () => {
    writeStatus(docPaths(file).statusPath, { location: "cloud", cloudDocId: "doc-9" });
    orgLookup = { data: null, error: { message: "not found" } };
    await expect(doAssetUpload(file, ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(upload).not.toHaveBeenCalled();
  });
});

// A doc attached by id alone (`inplan wait --remote <id>` — how an agent connects to a cloud plan
// it never had on disk) writes a sidecar with no status file, so the file-based entry point can't
// resolve it. Before this route existed, `asset-upload --remote` wasn't a recognized cloud command
// at all: it fell through to the generic remote handler and ran a sync instead of an upload, and
// agents worked around it by writing image *filenames* into the body as placeholders.
describe("inplan asset-upload --remote <docId>", () => {
  it("uploads without any local file or status sidecar", async () => {
    await doAssetUploadForDoc("doc-remote", ["--bytes-file", bytesFile, "--ext", "jpg"]);
    expect(upload).toHaveBeenCalledTimes(1);
    const [path, , opts] = upload.mock.calls[0]!;
    expect(path).toMatch(/^org-1\/doc-remote\/image-\d{14}-[0-9a-f]{8}\.jpg$/);
    expect(opts).toEqual({ contentType: "image/jpeg" });
    expect(lastJson()).toEqual({ status: "uploaded", relPath: `https://cdn.test/doc-images/${path}` });
  });

  it("stops on a doc id this session can't resolve to an org", async () => {
    // The org lookup is the ownership check — an id the caller can't read yields no org, so a
    // guessed doc id can't be used to write into someone else's bucket prefix.
    orgLookup = { data: null, error: null };
    await expect(doAssetUploadForDoc("someone-elses-doc", ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(upload).not.toHaveBeenCalled();
  });

  it("requires --bytes-file", async () => {
    await expect(doAssetUploadForDoc("doc-remote", [])).rejects.toThrow(/exit:64/);
    expect(exitCode).toBe(64);
    expect(stderr.join("")).toContain("--remote DOC_ID");
  });

  it("exits when not logged in", async () => {
    sessionPresent = false;
    await expect(doAssetUploadForDoc("doc-remote", ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(upload).not.toHaveBeenCalled();
  });
});

// The unit tests above call the upload body directly; this one goes through argv dispatch, which
// is where the bug actually lived — `asset-upload` reached neither the file branch (no sidecar to
// read) nor a cloud route, and fell through to the generic remote handler, which syncs rather than
// uploads. Asserting a real upload here is what pins the routing.
describe("argv dispatch: asset-upload --remote", () => {
  const argv = process.argv;
  afterEach(() => {
    process.argv = argv;
  });

  it("routes to storage instead of the collab/sync path", async () => {
    process.argv = ["node", "inplan", "asset-upload", "--remote", "doc-remote", "--bytes-file", bytesFile, "--ext", "png"];
    await main();
    expect(upload).toHaveBeenCalledTimes(1);
    expect(upload.mock.calls[0]![0]).toMatch(/^org-1\/doc-remote\/image-/);
    // A fall-through to the sync path prints live-collab guidance and never uploads, so the
    // uploaded envelope is the discriminator between the two routes.
    expect(lastJson()).toMatchObject({ status: "uploaded" });
    expect(stderr.join("")).not.toContain("live-collab");
  });
});

// The editor hands over raw bytes, not a path, so nothing else in the pipeline can recognise that
// a paste is a repeat of one already in the doc. Without the registry, pasting the same screenshot
// twice publishes two objects with identical content under unrelated random names.
describe("asset-upload content reuse", () => {
  it("reuses the registered object on a repeat paste of identical bytes", async () => {
    const bytes = readFileSync(bytesFile);
    const sha = createHash("sha256").update(bytes).digest("hex");
    assetRegistry.set(`${sha}|png`, "org-1/doc-9/image-20260101000000-deadbeef.png");

    await doAssetUploadForDoc("doc-9", ["--bytes-file", bytesFile, "--ext", "png"]);

    expect(upload).not.toHaveBeenCalled();
    expect(lastJson()).toEqual({
      status: "uploaded",
      relPath: "https://cdn.test/doc-images/org-1/doc-9/image-20260101000000-deadbeef.png",
      reused: true,
    });
  });

  it("registers a fresh upload, so the next identical paste reuses it", async () => {
    await doAssetUploadForDoc("doc-9", ["--bytes-file", bytesFile, "--ext", "png"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(assetInserts).toEqual([
      expect.objectContaining({ doc_id: "doc-9", ext: "png", object_path: upload.mock.calls[0]![0] }),
    ]);

    await doAssetUploadForDoc("doc-9", ["--bytes-file", bytesFile, "--ext", "png"]);
    expect(upload).toHaveBeenCalledTimes(1); // still one — the second paste reused
    expect(lastJson()).toMatchObject({ reused: true });
  });

  it("keys on the extension actually stored, so an unrecognized one still reuses", async () => {
    // uploadAssetBytes rewrites an unknown extension to png. Registering under the REQUESTED
    // extension would never match the object it produced, so every repeat paste of a .bmp would
    // upload again — the exact duplication this is meant to prevent.
    await doAssetUploadForDoc("doc-9", ["--bytes-file", bytesFile, "--ext", "bmp"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(assetInserts[0]).toMatchObject({ ext: "png" });

    await doAssetUploadForDoc("doc-9", ["--bytes-file", bytesFile, "--ext", "bmp"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(lastJson()).toMatchObject({ reused: true });
  });

  it("uploads normally when the registry is unavailable", async () => {
    assetRegistryError = { message: 'relation "doc_assets" does not exist' };
    await doAssetUploadForDoc("doc-9", ["--bytes-file", bytesFile, "--ext", "png"]);
    expect(upload).toHaveBeenCalledTimes(1);
    expect(lastJson()).toMatchObject({ status: "uploaded" });
  });
});
