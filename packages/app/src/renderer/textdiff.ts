// SPDX-License-Identifier: AGPL-3.0-or-later

/** A run of unchanged lines, or a change block (removed old lines / added new lines). */
export interface DiffSegment {
  same?: string[];
  removed?: string[];
  added?: string[];
}

/** LCS-based line diff of `a` -> `b`, grouped into same/change segments. */
export function lineSegments(a: string, b: string): DiffSegment[] {
  const A = a.split("\n");
  const B = b.split("\n");
  const n = A.length;
  const m = B.length;

  // dp[i][j] = LCS length of A[i:] and B[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = A[i] === B[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const segs: DiffSegment[] = [];
  const pushSame = (line: string) => {
    const last = segs[segs.length - 1];
    if (last && last.same) last.same.push(line);
    else segs.push({ same: [line] });
  };
  const pushChange = (rem: string | null, add: string | null) => {
    let last = segs[segs.length - 1];
    if (!last || (!last.removed && !last.added)) {
      last = { removed: [], added: [] };
      segs.push(last);
    }
    if (rem !== null) last.removed!.push(rem);
    if (add !== null) last.added!.push(add);
  };

  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      pushSame(A[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      pushChange(A[i]!, null);
      i++;
    } else {
      pushChange(null, B[j]!);
      j++;
    }
  }
  while (i < n) pushChange(A[i++]!, null);
  while (j < m) pushChange(null, B[j++]!);
  return segs;
}

/** True if a segment is a change block (has removed or added lines). */
export function isChange(s: DiffSegment): boolean {
  return Boolean((s.removed && s.removed.length) || (s.added && s.added.length));
}

/**
 * Rebuild the body from segments, taking the `added` side for accepted change
 * blocks and the `removed` (original) side for rejected ones. `accepted` is keyed
 * by the change block's index among change blocks.
 */
export function applySegments(segs: DiffSegment[], accepted: boolean[]): string {
  const out: string[] = [];
  let changeIdx = 0;
  for (const s of segs) {
    if (s.same) {
      out.push(...s.same);
    } else {
      const keepAdded = accepted[changeIdx] ?? true;
      out.push(...((keepAdded ? s.added : s.removed) ?? []));
      changeIdx++;
    }
  }
  return out.join("\n");
}
