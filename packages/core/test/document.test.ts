// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parse, ParseError, serialize } from "../src/document";
import type { Comment, ParsedDocument } from "../src/types";

const sample: ParsedDocument = {
  body: "# Plan\n\nThe plan should [use Postgres](#cmt-abc123) for storage.",
  comments: [
    { id: "cmt-abc123", author: "Tim <tim@xl8.ai>", date: "2026-05-28T13:34:00Z", resolved: false, text: "Why not SQLite?" },
    { id: "cmt-def456", parentId: "cmt-abc123", author: "Agent <agent@inplan>", date: "2026-05-28T13:40:00Z", resolved: false, text: "JSONB + scale." },
    { id: "cmt-doc111", anchor: "doc", author: "Tim <tim@xl8.ai>", date: "2026-05-28T14:00:00Z", resolved: false, text: "Looks close." },
  ],
};

describe("parse / serialize", () => {
  it("round-trips a document", () => {
    const round = parse(serialize(sample));
    expect(round).toEqual(sample);
  });

  it("parses a document with no data block to empty comments", () => {
    const doc = parse("# Just markdown\n\nNo comments here.\n");
    expect(doc.comments).toEqual([]);
    expect(doc.body).toBe("# Just markdown\n\nNo comments here.");
  });

  it("preserves a question comment with choices through a round-trip", () => {
    const q: Comment = {
      id: "cmt-q00001",
      author: "Agent <agent@inplan>",
      date: "2026-05-28T14:00:00Z",
      resolved: false,
      text: "Which targets?",
      question: {
        multiSelect: true,
        choices: [
          { label: "macOS", description: "" },
          { label: "Windows", description: "primary" },
        ],
      },
    };
    const doc: ParsedDocument = {
      body: "Pick [targets](#cmt-q00001).",
      comments: [q],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("parses an answer reply carrying `selected`", () => {
    const doc: ParsedDocument = {
      body: "no anchors",
      comments: [
        { id: "cmt-aaaaaa", author: "Tim <tim@xl8.ai>", date: "2026-05-28T14:00:00Z", resolved: false, selected: ["SQLite"], text: "go simple", parentId: "cmt-q00001" },
      ],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("ignores an inplan block inside a fenced code example and uses the real one", () => {
    const md = [
      "# Doc that documents its own format",
      "",
      "Example:",
      "",
      "```markdown",
      "<!--inplan",
      '[ { "id": "cmt-examp1", "author": "x", "date": "d", "resolved": false, "text": "example only" } ]',
      "-->",
      "```",
      "",
      "## Real content below the example",
      "Body text with [a span](#cmt-real01).",
      "",
      "<!--inplan",
      '[ { "id": "cmt-real01", "author": "Tim", "date": "d", "resolved": false, "text": "the real comment" } ]',
      "-->",
      "",
    ].join("\n");
    const doc = parse(md);
    expect(doc.comments.map((c) => c.id)).toEqual(["cmt-real01"]);
    // The fenced example must be preserved in the body, not consumed.
    expect(doc.body).toContain("```markdown");
    expect(doc.body).toContain("## Real content below the example");
  });

  it("throws on an unterminated data block", () => {
    expect(() => parse("text\n<!--inplan\n[]")).toThrow(ParseError);
  });

  it("throws on invalid JSON in the data block", () => {
    expect(() => parse("text\n<!--inplan\n[ not json ]\n-->")).toThrow(ParseError);
  });
});
