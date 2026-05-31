// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/renderer/markdown";

describe("renderMarkdown", () => {
  it("renders body markdown to HTML and tags blocks with data-line", () => {
    const html = renderMarkdown("# Title\n\nA paragraph.\n");
    expect(html).toContain("Title");
    expect(html).toContain("data-line=");
  });

  it("injects data-line onto fenced code blocks", () => {
    const html = renderMarkdown("# T\n\n```js\nconst x = 1;\n```\n");
    expect(html).toMatch(/<pre data-line="\d+"/);
    expect(html).toContain("const x = 1;");
  });
});
