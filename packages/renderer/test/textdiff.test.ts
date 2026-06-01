// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { applySegments, isChange, lineSegments, wordDiff } from "../src/textdiff";

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

describe("wordDiff", () => {
  it("marks only the changed words and reconstructs both sides", () => {
    const parts = wordDiff("use Postgres for storage", "use SQLite for storage");
    const del = parts.filter((p) => p.kind !== "add").map((p) => p.text).join("");
    const add = parts.filter((p) => p.kind !== "del").map((p) => p.text).join("");
    expect(del).toBe("use Postgres for storage");
    expect(add).toBe("use SQLite for storage");
    expect(parts.some((p) => p.kind === "del" && p.text.includes("Postgres"))).toBe(true);
    expect(parts.some((p) => p.kind === "add" && p.text.includes("SQLite"))).toBe(true);
    // unchanged words stay "same"
    expect(parts.some((p) => p.kind === "same" && p.text.includes("storage"))).toBe(true);
  });
});
