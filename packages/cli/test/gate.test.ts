// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize } from "@agent-planner/core";
import { describe, expect, it } from "vitest";
import { evaluateAgentEdit } from "../src/gate";

const comment = { id: "cmt-abc123", author: "a", date: "d", resolved: false, text: "?" };
const canonicalText = serialize({ body: "Use [Postgres](#cmt-abc123).", comments: [comment] });
const lostText = serialize({ body: "Use SQLite now.", comments: [comment] });
const danglingText = serialize({ body: "Use [x](#cmt-zzzzzz).", comments: [] });

describe("evaluateAgentEdit", () => {
  it("accepts an unchanged document", () => {
    const ev = evaluateAgentEdit(canonicalText, canonicalText, new Set());
    expect(ev.changed).toBe(false);
    expect(ev.lost).toEqual([]);
    expect(ev.integrityOk).toBe(true);
  });

  it("flags an unconfirmed lost comment without erroring on integrity", () => {
    const ev = evaluateAgentEdit(canonicalText, lostText, new Set());
    expect(ev.lost.map((c) => c.id)).toEqual(["cmt-abc123"]);
    expect(ev.unconfirmed.map((c) => c.id)).toEqual(["cmt-abc123"]);
    expect(ev.removedIds).toEqual([]);
    expect(ev.integrityOk).toBe(true); // span_missing_link is handled by the gate, not a hard error
  });

  it("removes a confirmed lost comment from the accepted document", () => {
    const ev = evaluateAgentEdit(canonicalText, lostText, new Set(["cmt-abc123"]));
    expect(ev.unconfirmed).toEqual([]);
    expect(ev.removedIds).toEqual(["cmt-abc123"]);
    expect(parse(ev.acceptedText).comments).toEqual([]);
    expect(ev.integrityOk).toBe(true);
  });

  it("reports structural corruption as a hard integrity error", () => {
    const ev = evaluateAgentEdit(canonicalText, danglingText, new Set());
    expect(ev.integrityOk).toBe(false);
    expect(ev.integrityErrors.map((e) => e.code)).toContain("dangling_link");
  });
});
