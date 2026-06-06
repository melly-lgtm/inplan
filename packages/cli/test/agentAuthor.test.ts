// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { agentAuthorFor } from "../src/agentAuthor";

describe("agentAuthorFor", () => {
  it("model-qualifies the author as `<model> <vendor@inplan.ai>`", () => {
    expect(agentAuthorFor("Opus 4.8")).toBe("Opus 4.8 <claude@inplan.ai>");
    expect(agentAuthorFor("Claude Sonnet 4.6")).toBe("Claude Sonnet 4.6 <claude@inplan.ai>");
  });

  it("infers the vendor local-part from the model family", () => {
    expect(agentAuthorFor("GPT-5")).toBe("GPT-5 <openai@inplan.ai>");
    expect(agentAuthorFor("o3")).toBe("o3 <openai@inplan.ai>");
    expect(agentAuthorFor("Gemini 2.5 Pro")).toBe("Gemini 2.5 Pro <gemini@inplan.ai>");
    expect(agentAuthorFor("Grok 4")).toBe("Grok 4 <grok@inplan.ai>");
  });

  it("falls back to `agent` for an unknown model family (still @inplan.ai)", () => {
    expect(agentAuthorFor("SomeFutureModel 1")).toBe("SomeFutureModel 1 <agent@inplan.ai>");
  });

  it("falls back to the bare agent author without a model", () => {
    expect(agentAuthorFor()).toBe("Agent <agent@inplan.ai>");
    expect(agentAuthorFor("")).toBe("Agent <agent@inplan.ai>");
    expect(agentAuthorFor("   ")).toBe("Agent <agent@inplan.ai>");
  });
});
