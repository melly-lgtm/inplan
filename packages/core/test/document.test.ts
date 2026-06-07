// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parse, ParseError, serialize } from "../src/document";
import type { Comment, ParsedDocument } from "../src/types";

const sample: ParsedDocument = {
  version: 1,
  body: "# Plan\n\nThe plan should [use Postgres](#cmt-abc123) for storage.",
  comments: [
    { id: "cmt-abc123", author: "Dana Lee <dana@example.com>", date: "2026-05-28T13:34:00Z", resolved: false, text: "Why not SQLite?" },
    { id: "cmt-def456", parentId: "cmt-abc123", author: "Agent <agent@inplan>", date: "2026-05-28T13:40:00Z", resolved: false, text: "JSONB + scale." },
    { id: "cmt-doc111", anchor: "doc", author: "Dana Lee <dana@example.com>", date: "2026-05-28T14:00:00Z", resolved: false, text: "Looks close." },
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
      version: 1,
      body: "Pick [targets](#cmt-q00001).",
      comments: [q],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("round-trips the optional may_resolve flag (agent's resolve suggestion)", () => {
    const doc: ParsedDocument = {
      version: 1,
      body: "Use [Postgres](#cmt-r00001).",
      comments: [
        { id: "cmt-r00001", author: "You", date: "2026-06-06T00:00:00Z", resolved: false, text: "datastore?" },
        { id: "cmt-r00002", parentId: "cmt-r00001", author: "Opus 4.8 <claude@inplan.ai>", date: "2026-06-06T00:00:01Z", resolved: false, text: "Adopted Postgres.", may_resolve: true },
      ],
    };
    expect(parse(serialize(doc))).toEqual(doc);
  });

  it("parses an answer reply carrying `selected`", () => {
    const doc: ParsedDocument = {
      version: 1,
      body: "no anchors",
      comments: [
        { id: "cmt-aaaaaa", author: "Dana Lee <dana@example.com>", date: "2026-05-28T14:00:00Z", resolved: false, selected: ["SQLite"], text: "go simple", parentId: "cmt-q00001" },
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
      '[ { "id": "cmt-real01", "author": "Dana Lee", "date": "d", "resolved": false, "text": "the real comment" } ]',
      "-->",
      "",
    ].join("\n");
    const doc = parse(md);
    expect(doc.comments.map((c) => c.id)).toEqual(["cmt-real01"]);
    // The fenced example must be preserved in the body, not consumed.
    expect(doc.body).toContain("```markdown");
    expect(doc.body).toContain("## Real content below the example");
  });

  it("defaults a version-less (legacy) block to version 1 and parses its comments", () => {
    const doc = parse('text\n\n<!--inplan\n[ { "id": "cmt-leg001", "author": "x", "date": "d", "resolved": false, "text": "legacy" } ]\n-->\n');
    expect(doc.version).toBe(1);
    expect(doc.comments.map((c) => c.id)).toEqual(["cmt-leg001"]);
  });

  it("reads an explicit version token off the marker without consuming the JSON", () => {
    const doc = parse('text\n\n<!--inplan v2\n[ { "id": "cmt-ver002", "author": "x", "date": "d", "resolved": false, "text": "v2" } ]\n-->\n');
    expect(doc.version).toBe(2);
    expect(doc.comments.map((c) => c.id)).toEqual(["cmt-ver002"]);
  });

  it("serialize stamps the current version onto the marker", () => {
    expect(serialize({ body: "b", comments: [] })).toContain("<!--inplan v1");
  });

  it("throws on an unterminated data block", () => {
    expect(() => parse("text\n<!--inplan\n[]")).toThrow(ParseError);
  });

  it("throws on invalid JSON in the data block", () => {
    expect(() => parse("text\n<!--inplan\n[ not json ]\n-->")).toThrow(ParseError);
  });

  it("throws when the data block is valid JSON but not an array", () => {
    expect(() => parse('text\n\n<!--inplan\n{ "id": "cmt-x" }\n-->\n')).toThrow(/must contain a JSON array/);
  });
});
