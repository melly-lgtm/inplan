// SPDX-License-Identifier: AGPL-3.0-or-later

const ID_PREFIX = "cmt-";
const ID_LEN = 6;

/** Matches a well-formed comment id: `cmt-` + base36. */
export const COMMENT_ID_RE = /^cmt-[0-9a-z]+$/;

/** A predicate (or set) describing which ids are already taken. */
export type Taken = Set<string> | ((id: string) => boolean);

function isTaken(taken: Taken | undefined, id: string): boolean {
  if (!taken) return false;
  return typeof taken === "function" ? taken(id) : taken.has(id);
}

/** Cryptographically random base36 string of the given length. */
function randomBase36(len: number): string {
  const bytes = new Uint8Array(len);
  // Web Crypto, available in Node 18+ (globalThis.crypto) and browsers.
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) {
    out += (bytes[i]! % 36).toString(36);
  }
  return out;
}

/**
 * Generate a unique comment id (`cmt-` + 6 base36 chars), avoiding ids that are
 * already taken. Used by both the editor and (via the skill) the agent.
 */
export function genId(taken?: Taken): string {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const id = ID_PREFIX + randomBase36(ID_LEN);
    if (!isTaken(taken, id)) return id;
  }
  throw new Error("genId: failed to generate a unique id after 1000 attempts");
}
