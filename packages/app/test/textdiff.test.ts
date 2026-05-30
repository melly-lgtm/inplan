// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { applySegments, isChange, lineSegments } from "../src/renderer/textdiff";

describe("lineSegments / applySegments", () => {
  it("produces same + change segments and applies accept/reject per hunk", () => {
    const a = "alpha\nbeta\ngamma";
    const b = "alpha\nBETA\ngamma";
    const segs = lineSegments(a, b);
    const changes = segs.filter(isChange);
    expect(changes).toHaveLength(1);
    // accept the hunk -> new text; reject -> original
    expect(applySegments(segs, [true])).toBe(b);
    expect(applySegments(segs, [false])).toBe(a);
  });

  it("handles pure insertions and deletions", () => {
    const ins = lineSegments("x\ny", "x\nnew\ny");
    expect(applySegments(ins, [true])).toBe("x\nnew\ny");
    expect(applySegments(ins, [false])).toBe("x\ny");

    const del = lineSegments("x\nold\ny", "x\ny");
    expect(applySegments(del, [true])).toBe("x\ny");
    expect(applySegments(del, [false])).toBe("x\nold\ny");
  });

  it("identical inputs yield no change hunks", () => {
    expect(lineSegments("a\nb", "a\nb").filter(isChange)).toHaveLength(0);
  });
});
