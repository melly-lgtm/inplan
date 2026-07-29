// SPDX-License-Identifier: AGPL-3.0-or-later

import { parse, serialize } from "@inplan/core";
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

describe("evaluateAgentEdit — descendant confirmation", () => {
  const reply = { id: "cmt-rep111", parentId: "cmt-abc123", author: "a", date: "d", resolved: false, text: "reply" };
  const grandchild = { id: "cmt-rep222", parentId: "cmt-rep111", author: "a", date: "d", resolved: false, text: "reply-of-reply" };
  const canonicalWithReply = serialize({ body: "Use [Postgres](#cmt-abc123).", comments: [comment, reply] });
  const lostWithReply = serialize({ body: "Use SQLite now.", comments: [comment, reply] });
  const canonicalWithGrandchild = serialize({ body: "Use [Postgres](#cmt-abc123).", comments: [comment, reply, grandchild] });
  const lostWithGrandchild = serialize({ body: "Use SQLite now.", comments: [comment, reply, grandchild] });

  it("leaves an unconfirmed reply behind as a missing_parent error, rather than silently dropping it", () => {
    const ev = evaluateAgentEdit(canonicalWithReply, lostWithReply, new Set(["cmt-abc123"]));
    expect(ev.removedIds).toEqual(["cmt-abc123"]);
    expect(parse(ev.acceptedText).comments.map((c) => c.id)).toEqual(["cmt-rep111"]);
    expect(ev.integrityOk).toBe(false);
    expect(ev.integrityErrors.map((e) => e.code)).toContain("missing_parent");
  });

  it("removes a confirmed reply along with its confirmed orphaned parent", () => {
    const ev = evaluateAgentEdit(canonicalWithReply, lostWithReply, new Set(["cmt-abc123", "cmt-rep111"]));
    expect(new Set(ev.removedIds)).toEqual(new Set(["cmt-abc123", "cmt-rep111"]));
    expect(parse(ev.acceptedText).comments).toEqual([]);
    expect(ev.integrityOk).toBe(true);
  });

  it("cascades transitively through a reply-of-reply when the whole chain is confirmed", () => {
    const ev = evaluateAgentEdit(canonicalWithGrandchild, lostWithGrandchild, new Set(["cmt-abc123", "cmt-rep111", "cmt-rep222"]));
    expect(new Set(ev.removedIds)).toEqual(new Set(["cmt-abc123", "cmt-rep111", "cmt-rep222"]));
    expect(parse(ev.acceptedText).comments).toEqual([]);
    expect(ev.integrityOk).toBe(true);
  });

  it("does not skip ahead past an unconfirmed middle reply, even if the grandchild is confirmed", () => {
    const ev = evaluateAgentEdit(canonicalWithGrandchild, lostWithGrandchild, new Set(["cmt-abc123", "cmt-rep222"]));
    expect(new Set(ev.removedIds)).toEqual(new Set(["cmt-abc123"]));
    expect(parse(ev.acceptedText).comments.map((c) => c.id).sort()).toEqual(["cmt-rep111", "cmt-rep222"]);
    expect(ev.integrityOk).toBe(false);
    expect(ev.integrityErrors.map((e) => e.code)).toContain("missing_parent");
  });
});
