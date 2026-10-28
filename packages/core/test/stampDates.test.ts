// SPDX-License-Identifier: AGPL-3.0-or-later
//
// A comment's `date` is written by whoever authored it, so it is a claim rather than an
// observation — and orderComments sorts by (date, id) at every projection, so a claim about the
// future parks that reply at the end of its thread permanently, after the replies that answered
// it. Observed in production: an agent hand-stamped round-hour times ("2026-10-28T02:00:00Z")
// because `inplan comment` refuses cloud docs, leaving hand-editing as the only way in.

import { describe, expect, it } from "vitest";
import { DATE_SKEW_TOLERANCE_MS, stampImpossibleDates } from "../src/document";
import type { Comment } from "../src/types";

const NOW = Date.parse("2026-10-28T00:30:00.000Z");
const at = (date: string, id = "cmt-x"): Comment => ({ id, author: "a", date, resolved: false, text: "t" });

describe("stampImpossibleDates", () => {
  it("replaces a date in the future with the clock", () => {
    const { comments, repaired } = stampImpossibleDates([at("2026-10-28T02:00:00Z")], NOW);
    expect(repaired).toEqual(["cmt-x"]);
    expect(comments[0]!.date).toBe(new Date(NOW).toISOString());
  });

  it("leaves a past date untouched, and returns the SAME array when nothing needs repair", () => {
    const input = [at("2026-10-27T22:39:17.305Z"), at("2026-10-28T00:16:34.235Z", "cmt-y")];
    const { comments, repaired } = stampImpossibleDates(input, NOW);
    expect(repaired).toEqual([]);
    // Identity, not just equality: an untouched document must not look like an edit downstream.
    expect(comments).toBe(input);
  });

  it("tolerates small clock skew rather than rewriting a collaborator's timestamp", () => {
    const slightlyAhead = new Date(NOW + DATE_SKEW_TOLERANCE_MS - 1_000).toISOString();
    expect(stampImpossibleDates([at(slightlyAhead)], NOW).repaired).toEqual([]);
    const wayAhead = new Date(NOW + DATE_SKEW_TOLERANCE_MS + 1_000).toISOString();
    expect(stampImpossibleDates([at(wayAhead)], NOW).repaired).toEqual(["cmt-x"]);
  });

  it("repairs an absent or unparseable date", () => {
    expect(stampImpossibleDates([at("")], NOW).repaired).toEqual(["cmt-x"]);
    expect(stampImpossibleDates([at("not a date")], NOW).repaired).toEqual(["cmt-x"]);
  });

  it("preserves every other field of a repaired comment", () => {
    const c: Comment = { id: "cmt-q", parentId: "cmt-p", author: "Opus", date: "2099-01-01T00:00:00Z", resolved: true, text: "hi", may_resolve: true };
    const out = stampImpossibleDates([c], NOW).comments[0]!;
    expect({ ...out, date: "" }).toEqual({ ...c, date: "" });
  });
});
