// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure defaults for the Create Doc / Move Text to New Doc actions: a safe Markdown filename and,
// for Move, a title derived from the selected text. Kept platform-free — the host owns *where*
// the file lands; this only proposes the title + filename the modal pre-fills.

/** A safe default Markdown filename from arbitrary text: lowercased, spaces → "_", unsafe chars
 *  dropped, repeats collapsed, with a ".md" extension. Falls back to "untitled.md". */
export function slugifyFilename(text: string): string {
  const base = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]+/g, "")
    .replace(/_{2,}/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return `${base || "untitled"}.md`;
}

/** Default title for Move Text to New Doc: the first sentence OR the first five words — whichever
 *  is shorter — with trailing sentence punctuation trimmed. Whitespace is collapsed. */
export function moveDocTitle(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  if (!flat) return "Untitled";
  const sentence = flat.match(/^[^.!?]*[.!?]/)?.[0]?.trim() ?? flat;
  const fiveWords = flat.split(" ").slice(0, 5).join(" ");
  const pick = sentence.length <= fiveWords.length ? sentence : fiveWords;
  return pick.replace(/[.!?]+$/, "").trim() || "Untitled";
}
