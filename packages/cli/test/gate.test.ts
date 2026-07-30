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

  it("surfaces an unconfirmed dangling reply as `unconfirmed`, naming exactly what to confirm next — rather than a bare missing_parent error", () => {
    const ev = evaluateAgentEdit(canonicalWithReply, lostWithReply, new Set(["cmt-abc123"]));
    expect(ev.removedIds).toEqual(["cmt-abc123"]);
    expect(parse(ev.acceptedText).comments.map((c) => c.id)).toEqual(["cmt-rep111"]);
    // The reply isn't silently dropped OR left to fail as a generic integrity error — it's named
    // in `unconfirmed`, same signal as a newly-orphaned root, so `wait`'s confirm_required response
    // tells the caller exactly which id to add next time instead of them inferring it from an error.
    expect(ev.unconfirmed.map((c) => c.id)).toEqual(["cmt-rep111"]);
    expect(ev.integrityOk).toBe(true);
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
    // Only the middle reply dangles (its parent was removed); the grandchild's own parent — the
    // middle reply — is still present in the accepted doc, so it isn't itself flagged.
    expect(ev.unconfirmed.map((c) => c.id)).toEqual(["cmt-rep111"]);
    expect(ev.integrityOk).toBe(true);
  });

  it("cascades regardless of array order — a descendant listed before its ancestor still gets pulled in", () => {
    // Reversed order: grandchild, then reply, then root. A single non-repeating pass over the
    // array (in this order) would reach the grandchild before its parent (the reply) has been
    // added to the removal set, and never revisit it — so it would wrongly leave the grandchild
    // dangling. The fixpoint loop (repeat until nothing new is added) doesn't depend on order.
    const reversedCanonical = serialize({ body: "Use [Postgres](#cmt-abc123).", comments: [grandchild, reply, comment] });
    const reversedLost = serialize({ body: "Use SQLite now.", comments: [grandchild, reply, comment] });
    const ev = evaluateAgentEdit(reversedCanonical, reversedLost, new Set(["cmt-abc123", "cmt-rep111", "cmt-rep222"]));
    expect(new Set(ev.removedIds)).toEqual(new Set(["cmt-abc123", "cmt-rep111", "cmt-rep222"]));
    expect(parse(ev.acceptedText).comments).toEqual([]);
    expect(ev.unconfirmed).toEqual([]);
    expect(ev.integrityOk).toBe(true);
  });

  it("requires confirmation for a reply deleted outright from current, not just left dangling", () => {
    // This edit didn't just orphan the root and leave the reply in place — it removed the reply
    // object entirely, so it's present in canonical but absent from current altogether. Nothing in
    // current alone can reveal that a reply ever existed there, let alone that its removal was never
    // confirmed — the descendant scan has to fall back to canonical to still catch it.
    const currentWithoutReply = serialize({ body: "Use SQLite now.", comments: [comment] });
    const ev = evaluateAgentEdit(canonicalWithReply, currentWithoutReply, new Set(["cmt-abc123"]));
    expect(ev.removedIds).toEqual(["cmt-abc123"]);
    expect(ev.unconfirmed.map((c) => c.id)).toEqual(["cmt-rep111"]);
    expect(ev.integrityOk).toBe(true); // gated via `unconfirmed`, same as any other dangling descendant
  });

  it("requires confirmation for a grandchild deleted outright, even with its parent reply confirmed and intact", () => {
    const currentWithoutGrandchild = serialize({ body: "Use SQLite now.", comments: [comment, reply] });
    const ev = evaluateAgentEdit(canonicalWithGrandchild, currentWithoutGrandchild, new Set(["cmt-abc123", "cmt-rep111"]));
    expect(new Set(ev.removedIds)).toEqual(new Set(["cmt-abc123", "cmt-rep111"]));
    expect(ev.unconfirmed.map((c) => c.id)).toEqual(["cmt-rep222"]);
    expect(ev.integrityOk).toBe(true);
  });

  it("accepts an outright-deleted descendant once it's also confirmed", () => {
    const currentWithoutReply = serialize({ body: "Use SQLite now.", comments: [comment] });
    const ev = evaluateAgentEdit(canonicalWithReply, currentWithoutReply, new Set(["cmt-abc123", "cmt-rep111"]));
    expect(new Set(ev.removedIds)).toEqual(new Set(["cmt-abc123", "cmt-rep111"]));
    expect(ev.unconfirmed).toEqual([]);
    expect(ev.integrityOk).toBe(true);
  });
});
