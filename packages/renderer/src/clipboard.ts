// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Carry span-comment threads through copy/cut/paste. The platform's "web custom format"
// clipboard channel is async-only (ClipboardItem + navigator.clipboard.read), which would
// force an async read on every paste and a clipboard-read permission prompt on the web. We
// instead pigg-back on the standard, synchronous `text/html` representation of the
// ClipboardEvent: the visible text is the copied Markdown (with its `[label](#cmt-id)` anchor
// links intact), and an invisible attribute carries the comment threads as a base64 payload.
//
// On paste we re-ID every carried comment (so a paste never collides with — or aliases — an
// existing thread), rewrite the fragment's anchor hrefs to the new ids, and hand both back to
// the app to splice in. Non-inplan HTML (or a plain-text-only clipboard) has no marker, so we
// fall through to the editor's native paste — plain text, no comments.

import { genId, type Comment } from "@inplan/core";

/** Attribute on the wrapper element of our `text/html` payload, holding base64(JSON). */
const CLIP_ATTR = "data-inplan-clip";
/** Pre-compiled extractor for the payload attribute (avoids rebuilding the regex per paste). */
const CLIP_ATTR_RE = new RegExp(`${CLIP_ATTR}="([^"]*)"`);

/** A full anchor link `[label](#cmt-id)` — the id is only carried when its WHOLE anchor is
 *  inside the copied fragment, so a paste never produces a dangling `](#cmt-id)`. */
const FULL_ANCHOR = /\[[^\]]*\]\(#(cmt-[0-9a-z]+)\)/gi;
/** The href portion alone, for rewriting ids in place. */
const ANCHOR_HREF = /\]\(#(cmt-[0-9a-z]+)\)/gi;

export interface ClipboardPayload {
  v: 1;
  comments: Comment[];
}

/** The cmt-ids whose complete anchor link appears in `fragment`. */
export function anchorIdsIn(fragment: string): string[] {
  const ids: string[] = [];
  for (const m of fragment.matchAll(FULL_ANCHOR)) ids.push(m[1]!);
  return ids;
}

/** The comment threads to carry: each anchored root in `ids` plus every descendant
 *  reply/answer (transitively), in document order. */
export function threadsFor(ids: string[], all: Comment[]): Comment[] {
  const keep = new Set<string>(ids);
  let changed = true;
  while (changed) {
    changed = false;
    for (const c of all) {
      if (c.parentId && keep.has(c.parentId) && !keep.has(c.id)) {
        keep.add(c.id);
        changed = true;
      }
    }
  }
  return all.filter((c) => keep.has(c.id));
}

/** Re-ID each carried comment against `taken` (and the ids minted so far), remapping
 *  parentId references to their new ids. Returns the rewritten comments plus an old→new
 *  id map used to rewrite the fragment's anchor hrefs. */
export function remapComments(comments: Comment[], taken: Set<string>): { comments: Comment[]; idMap: Map<string, string> } {
  const used = new Set(taken);
  const idMap = new Map<string, string>();
  for (const c of comments) {
    const id = genId(used);
    used.add(id);
    idMap.set(c.id, id);
  }
  const remapped = comments.map((c) => ({
    ...c,
    id: idMap.get(c.id)!,
    ...(c.parentId !== undefined ? { parentId: idMap.get(c.parentId) ?? c.parentId } : {}),
  }));
  return { comments: remapped, idMap };
}

/** Rewrite `](#cmt-old)` anchor hrefs in `fragment` to their mapped new ids; hrefs with no
 *  mapping are left untouched. */
export function rewriteAnchors(fragment: string, idMap: Map<string, string>): string {
  return fragment.replace(ANCHOR_HREF, (whole, id: string) => {
    const next = idMap.get(id);
    return next ? `](#${next})` : whole;
  });
}

// --- text/html (de)serialization --------------------------------------------------

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** UTF-8-safe base64 (btoa only handles Latin-1). */
function toBase64(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** Build the `text/html` clipboard representation: the copied text (visible) plus the comment
 *  payload tucked into an attribute (invisible when pasted into a rich target). */
export function buildClipHtml(text: string, comments: Comment[]): string {
  const payload: ClipboardPayload = { v: 1, comments };
  return `<span ${CLIP_ATTR}="${toBase64(JSON.stringify(payload))}">${escapeHtml(text)}</span>`;
}

/** Extract the inplan comment payload embedded in a `text/html` clipboard string, or null when
 *  the HTML carries no inplan marker (a foreign paste). */
export function readClipHtml(html: string): ClipboardPayload | null {
  const m = CLIP_ATTR_RE.exec(html);
  if (!m) return null;
  try {
    const payload = JSON.parse(fromBase64(m[1]!)) as unknown;
    if (payload && typeof payload === "object" && (payload as ClipboardPayload).v === 1 && Array.isArray((payload as ClipboardPayload).comments)) {
      return payload as ClipboardPayload;
    }
  } catch {
    /* malformed payload → treat as a foreign paste */
  }
  return null;
}
