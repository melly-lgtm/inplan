// SPDX-License-Identifier: AGPL-3.0-or-later
//
// `inplan asset-upload` is what the desktop app shells out to when it's live-connected to a
// cloud doc (Collaborate on Cloud): it reads bytes from a temp file, resolves the doc's org via
// the `documents` table, and uploads to the `doc-images` bucket — mirroring the cloud web app's
// own saveAsset (same bucket, same org/doc path scheme, same 409-collision retry). Covers a
// non-cloud doc, a missing --bytes-file, a logged-out session, a normal upload, a collision retry,
// a hard storage failure, and the unknown-extension → png fallback — all over a mocked authed
// session, no network.

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { docPaths, writeStatus } from "@inplan/core/node";

let uploadResult: { error: { status: number; message: string } | null } = { error: null };
let orgLookup: { data: unknown; error: unknown } = { data: { org_id: "org-1" }, error: null };
let sessionPresent = true;
const upload = vi.fn(async (_path: string, _bytes: unknown, _opts: unknown) => uploadResult);
const getPublicUrl = vi.fn((path: string) => ({ data: { publicUrl: `https://cdn.test/doc-images/${path}` } }));

function fakeDb() {
  const q: Record<string, unknown> = {};
  q.select = () => q;
  q.eq = () => q;
  q.maybeSingle = () => Promise.resolve(orgLookup);
  return {
    from: () => q,
    storage: { from: () => ({ upload, getPublicUrl }) },
  };
}

vi.mock("../src/cliAuth", () => ({
  authedSession: vi.fn(async () => (sessionPresent ? { db: fakeDb(), session: { user: { id: "user-1" } } } : null)),
}));

import { doAssetUpload } from "../src/cli";

let home: string;
let file: string;
let bytesFile: string;
let out: string[];
let exitCode: number | null;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "inplan-asset-upload-"));
  process.env.INPLAN_SIDECAR_DIR = join(home, "sidecars");
  file = join(home, "PLAN.md");
  writeFileSync(file, "# My Plan\n\nbody\n");
  bytesFile = join(home, "bytes.bin");
  writeFileSync(bytesFile, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
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
  it("rejects a doc that isn't cloud-connected", async () => {
    await expect(doAssetUpload(file, ["--bytes-file", bytesFile])).rejects.toThrow(/exit:1/);
    expect(exitCode).toBe(1);
    expect(upload).not.toHaveBeenCalled();
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
