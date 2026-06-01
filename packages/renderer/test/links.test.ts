// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { isInternalDocLink, resolveDocPath } from "../src/links";

describe("isInternalDocLink", () => {
  it("accepts relative .md links (with optional query/anchor)", () => {
    expect(isInternalDocLink("./design.md")).toBe(true);
    expect(isInternalDocLink("../README.md")).toBe(true);
    expect(isInternalDocLink("sub/x.md#frag")).toBe(true);
    expect(isInternalDocLink("y.md?v=1")).toBe(true);
  });

  it("rejects external URLs, non-md targets, and bare anchors", () => {
    expect(isInternalDocLink("https://example.com/y.md")).toBe(false);
    expect(isInternalDocLink("mailto:a@b.c")).toBe(false);
    expect(isInternalDocLink("#section")).toBe(false);
    expect(isInternalDocLink("./image.png")).toBe(false);
    expect(isInternalDocLink("//cdn/x.md")).toBe(false);
    expect(isInternalDocLink("")).toBe(false);
  });
});

describe("resolveDocPath", () => {
  it("joins a relative href against the base doc's directory, normalizing . and ..", () => {
    expect(resolveDocPath("docs/PLAN.md", "./design.md")).toBe("docs/design.md");
    expect(resolveDocPath("docs/PLAN.md", "../README.md")).toBe("README.md");
    expect(resolveDocPath("docs/sub/a.md", "../b.md")).toBe("docs/b.md");
    expect(resolveDocPath("a.md", "./b.md")).toBe("b.md");
    expect(resolveDocPath("docs/PLAN.md", "/root.md")).toBe("root.md"); // repo-absolute
    expect(resolveDocPath("docs/PLAN.md", "./x.md#sec")).toBe("docs/x.md"); // drops anchor
  });
});
