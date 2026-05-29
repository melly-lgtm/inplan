// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { COMMENT_ID_RE, genId } from "../src/ids";

describe("genId", () => {
  it("produces well-formed `cmt-` + 6 base36 ids", () => {
    for (let i = 0; i < 200; i++) {
      const id = genId();
      expect(id).toMatch(/^cmt-[0-9a-z]{6}$/);
      expect(COMMENT_ID_RE.test(id)).toBe(true);
    }
  });

  it("produces unique ids in bulk", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) seen.add(genId());
    expect(seen.size).toBe(2000);
  });

  it("avoids ids that are already taken (set)", () => {
    const taken = new Set<string>();
    for (let i = 0; i < 100; i++) taken.add(genId());
    for (let i = 0; i < 500; i++) {
      expect(taken.has(genId(taken))).toBe(false);
    }
  });

  it("avoids ids that are already taken (predicate)", () => {
    const blocked = genId();
    const id = genId((candidate) => candidate === blocked);
    expect(id).not.toBe(blocked);
  });
});
