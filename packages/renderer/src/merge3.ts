// SPDX-License-Identifier: AGPL-3.0-or-later

// Line-based three-way merge for STALE proposal review (proposals v1): a proposal written
// against an older canonical (`base`) is diffed for review as merge3(base, current, proposal) —
// the proposal's changes replayed onto the current canonical. The reviewer then sees exactly the
// proposal's own edits as hunks against today's document, and the same path covers accepting
// several proposals in sequence (each later one is stale relative to the earlier acceptance).
//
// Conflict policy: where both sides changed the same base region differently, the PROPOSAL wins
// in the merged text — the result is only the review diff, so the human sees the conflicting
// hunk against the current canonical and can reject it; nothing is applied until they accept.

/** One side's change to the base: base lines [start, start+count) become `out`. */
interface ChangeBlock {
  start: number;
  count: number;
  out: string[];
}

/** Extract change blocks of base -> next from an LCS walk (same shape as textdiff's, but
 *  positioned by base line index, which the merge needs and DiffSegment does not carry). */
function changeBlocks(base: string[], next: string[]): ChangeBlock[] {
  const n = base.length;
  const m = next.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = base[i] === next[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const blocks: ChangeBlock[] = [];
  let cur: ChangeBlock | null = null;
  const open = (at: number): ChangeBlock => {
    if (!cur) {
      cur = { start: at, count: 0, out: [] };
      blocks.push(cur);
    }
    return cur;
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (base[i] === next[j]) {
      cur = null;
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      open(i).count++;
      i++;
    } else {
      open(i).out.push(next[j]!);
      j++;
    }
  }
  while (i < n) {
    open(i).count++;
    i++;
  }
  while (j < m) {
    open(n).out.push(next[j]!);
    j++;
  }
  return blocks;
}

/** Replay one side's blocks over the base region [lo, hi) (blocks are non-overlapping and
 *  sorted; only those starting inside the region are passed). */
function replay(base: string[], lo: number, hi: number, blocks: ChangeBlock[]): string[] {
  const out: string[] = [];
  let idx = lo;
  for (const b of blocks) {
    for (; idx < b.start; idx++) out.push(base[idx]!);
    out.push(...b.out);
    idx = b.start + b.count;
  }
  for (; idx < hi; idx++) out.push(base[idx]!);
  return out;
}

/**
 * Merge `theirs`' changes (relative to `base`) onto `ours`. Regions of the base touched by only
 * one side take that side's text; regions both sides changed identically collapse; regions they
 * changed differently take THEIRS (see the conflict policy above). Untouched base lines pass
 * through (they are identical in all three).
 */
export function merge3(base: string, ours: string, theirs: string): string {
  const B = base.split("\n");
  const blocksO = changeBlocks(B, ours.split("\n"));
  const blocksT = changeBlocks(B, theirs.split("\n"));

  // Group blocks from both sides into regions of the base: blocks whose base spans touch
  // (inclusive of insertion points — an insertion at the boundary of the other side's change is
  // ambiguous and must be decided as one region, not interleaved line by line).
  type Tagged = ChangeBlock & { side: "ours" | "theirs" };
  const all: Tagged[] = [...blocksO.map((b) => ({ ...b, side: "ours" as const })), ...blocksT.map((b) => ({ ...b, side: "theirs" as const }))].sort(
    (a, b) => a.start - b.start || a.side.localeCompare(b.side),
  );

  const out: string[] = [];
  let base_idx = 0;
  let k = 0;
  while (k < all.length) {
    // Grow the region transitively: [lo, hi] in base coords, spans touching when they intersect
    // as closed ranges (an insertion has count 0 and still occupies its point).
    let lo = all[k]!.start;
    let hi = all[k]!.start + all[k]!.count;
    const region: Tagged[] = [all[k]!];
    k++;
    while (k < all.length && all[k]!.start <= hi) {
      hi = Math.max(hi, all[k]!.start + all[k]!.count);
      region.push(all[k]!);
      k++;
    }
    for (; base_idx < lo; base_idx++) out.push(B[base_idx]!);
    const oursHere = region.filter((b) => b.side === "ours");
    const theirsHere = region.filter((b) => b.side === "theirs");
    const oursOut = replay(B, lo, hi, oursHere);
    const theirsOut = replay(B, lo, hi, theirsHere);
    if (theirsHere.length === 0) out.push(...oursOut);
    else if (oursHere.length === 0) out.push(...theirsOut);
    else if (oursOut.join("\n") === theirsOut.join("\n")) out.push(...oursOut);
    else out.push(...theirsOut); // conflict — the proposal wins in the REVIEW diff (see header)
    base_idx = hi;
  }
  for (; base_idx < B.length; base_idx++) out.push(B[base_idx]!);
  return out.join("\n");
}
