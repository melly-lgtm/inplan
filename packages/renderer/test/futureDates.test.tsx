// SPDX-License-Identifier: AGPL-3.0-or-later
// @vitest-environment happy-dom
//
// The viewer's half of the fabricated-date problem (see core's stampDates.test.ts). A comment
// claiming the future is already on screen, so rendering "in 2 hours" for it reads as a glitch
// and makes a thread look out of sequence. Ordering must not be at the mercy of the claim either.

import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { RelativeTime } from "../src/RelativeTime";
import { buildThreads } from "../src/docOps";
import type { Comment } from "@inplan/core";

const NOW = Date.parse("2026-10-28T00:30:00.000Z");
const c = (id: string, date: string, parentId?: string): Comment =>
  ({ id, date, parentId, author: "a", resolved: false, text: id } as Comment);

afterEach(cleanup);

describe("a comment that claims the future", () => {
  it("renders as the present, not as 'in 2 hours'", () => {
    render(<RelativeTime iso={new Date(Date.now() + 2 * 3600_000).toISOString()} />);
    const el = screen.getByRole("time");
    expect(el.textContent).not.toMatch(/^in /); // dayjs' future form
    expect(el.textContent).toMatch(/ago|few seconds/);
  });

  it("keeps the stored value in the tooltip, so nothing is hidden from someone who looks", () => {
    const iso = "2099-01-01T00:00:00.000Z";
    render(<RelativeTime iso={iso} />);
    const el = screen.getByRole("time");
    expect(el.getAttribute("datetime")).toBe(iso);        // unaltered
    // The tooltip is LOCAL time, so the stored UTC instant can land either side of the year
    // boundary depending on the runner's zone — assert the instant, not one rendering of it.
    expect(Date.parse(el.getAttribute("title")!)).toBe(Date.parse(iso));
  });

  it("does not let an invalid date sort a reply to an end of the thread", () => {
    // "" and garbage used to go through localeCompare, which orders them by string, not by time.
    const threads = buildThreads(
      [c("cmt-root", "2026-10-28T00:00:00Z"), c("cmt-a", "2026-10-28T00:10:00Z", "cmt-root"), c("cmt-bad", "", "cmt-root"), c("cmt-b", "2026-10-28T00:20:00Z", "cmt-root")],
      NOW,
    );
    // The undated reply is treated as "now" — later than the dated ones, and in array position
    // relative to anything else undated. It must not land before cmt-a.
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["cmt-a", "cmt-b", "cmt-bad"]);
  });

  it("orders two future-claiming replies by their array position, not by how far they overreach", () => {
    // Both clamp to now, so the tiebreak decides — and array order is the only remaining signal.
    const threads = buildThreads(
      [c("cmt-root", "2026-10-28T00:00:00Z"), c("cmt-first", "2099-01-01T00:00:00Z", "cmt-root"), c("cmt-second", "2030-01-01T00:00:00Z", "cmt-root")],
      NOW,
    );
    expect(threads[0]!.replies.map((r) => r.id)).toEqual(["cmt-first", "cmt-second"]);
  });
});
