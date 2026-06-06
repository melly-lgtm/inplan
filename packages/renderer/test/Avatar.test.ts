// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { parseAuthor } from "../src/Avatar";

describe("parseAuthor — agent vs human classification", () => {
  it("treats a model-qualified @inplan.ai address as an agent (vendor = local-part)", () => {
    expect(parseAuthor("Opus 4.8 <claude@inplan.ai>")).toEqual({ name: "Opus 4.8", email: "claude@inplan.ai", vendor: "claude" });
  });

  it("still treats the legacy bare @inplan address as an agent", () => {
    // Documents created before model-qualified authors used "Agent <agent@inplan>".
    expect(parseAuthor("Agent <agent@inplan>")).toEqual({ name: "Agent", email: "agent@inplan", vendor: "agent" });
  });

  it("treats an ordinary email as a human (no vendor)", () => {
    expect(parseAuthor("Ada Lovelace <ada@example.com>").vendor).toBeNull();
  });

  it("tolerates a bare name with no address", () => {
    expect(parseAuthor("You")).toEqual({ name: "You", email: "", vendor: null });
  });
});
