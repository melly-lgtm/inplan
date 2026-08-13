// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { detectMentionTrigger, filterMentionCandidates } from "../src/mentionAutocomplete";

describe("detectMentionTrigger", () => {
  it("finds a trigger word starting at the beginning of the text", () => {
    expect(detectMentionTrigger("@bo", 3)).toEqual({ start: 0, query: "bo" });
  });

  it("finds a trigger word after whitespace", () => {
    expect(detectMentionTrigger("hey @bo", 7)).toEqual({ start: 4, query: "bo" });
  });

  it("returns an empty query right after typing '@'", () => {
    expect(detectMentionTrigger("hey @", 5)).toEqual({ start: 4, query: "" });
  });

  it("returns null when there's no '@' before the caret", () => {
    expect(detectMentionTrigger("hey bob", 7)).toBeNull();
  });

  it("returns null once the trigger word is closed by whitespace", () => {
    expect(detectMentionTrigger("hey @bob then more", 10)).toBeNull();
  });

  it("returns null for a mid-word '@' (e.g. typing an email as prose)", () => {
    expect(detectMentionTrigger("dana@example.com", 5)).toBeNull();
  });

  it("returns null once a second '@' closes the word", () => {
    expect(detectMentionTrigger("@bo@ba", 6)).toBeNull();
  });

  it("returns null when the caret sits before the '@'", () => {
    expect(detectMentionTrigger("hey @bob", 2)).toBeNull();
  });
});

describe("filterMentionCandidates", () => {
  const users = [
    { email: "bob@example.com", name: "Bob" },
    { email: "alice@example.com", name: "Alice" },
    { email: "carol@example.com" },
  ];

  it("returns all candidates (capped) for an empty query", () => {
    expect(filterMentionCandidates(users, "")).toEqual(users);
  });

  it("matches case-insensitively on email", () => {
    expect(filterMentionCandidates(users, "BOB")).toEqual([users[0]]);
  });

  it("matches on display name too", () => {
    expect(filterMentionCandidates(users, "ali")).toEqual([users[1]]);
  });

  it("caps results at 6", () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ email: `u${i}@example.com` }));
    expect(filterMentionCandidates(many, "")).toHaveLength(6);
  });

  it("returns no candidates for a query matching nobody", () => {
    expect(filterMentionCandidates(users, "zzz")).toEqual([]);
  });
});
