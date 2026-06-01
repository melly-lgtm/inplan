// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { agentAuthorFor } from "../src/agentAuthor";

describe("agentAuthorFor", () => {
  it("model-qualifies the author when a model is given", () => {
    expect(agentAuthorFor("Opus 4.8")).toBe("Agent (Opus 4.8) <agent@inplan>");
  });

  it("falls back to the bare agent author without a model", () => {
    expect(agentAuthorFor()).toBe("Agent <agent@inplan>");
    expect(agentAuthorFor("")).toBe("Agent <agent@inplan>");
    expect(agentAuthorFor("   ")).toBe("Agent <agent@inplan>");
  });
});
