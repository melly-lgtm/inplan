// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { toolActivityText } from "../src/relayActivity";

describe("toolActivityText", () => {
  it("Bash appends the command (first 30 chars, whitespace-collapsed)", () => {
    expect(toolActivityText("Bash", { command: "npm run build" })).toBe("Bash: npm run build");
    expect(toolActivityText("Bash", { command: "  ls   -la \n foo " })).toBe("Bash: ls -la foo");
    expect(toolActivityText("Bash", { command: "x".repeat(50) })).toBe("Bash: " + "x".repeat(30) + "…");
  });

  it("file tools show the file (short paths in full)", () => {
    expect(toolActivityText("Edit", { file_path: "src/StatusBar.tsx" })).toBe("Edit: src/StatusBar.tsx");
    expect(toolActivityText("Write", { file_path: "README.md" })).toBe("Write: README.md");
    expect(toolActivityText("Read", { file_path: "package.json" })).toBe("Read: package.json");
    expect(toolActivityText("NotebookEdit", { notebook_path: "nb.ipynb" })).toBe("NotebookEdit: nb.ipynb");
  });

  it("a long file path keeps the tail so the filename stays visible", () => {
    const r = toolActivityText("Edit", { file_path: "/very/deeply/nested/path/to/the/final.ts" });
    expect(r.startsWith("Edit: …")).toBe(true);
    expect(r.endsWith("final.ts")).toBe(true);
    expect(r.length).toBe("Edit: ".length + 31); // "…" + the last 30 chars
  });

  it("falls back to the bare tool name when there's no usable detail", () => {
    expect(toolActivityText("Bash", {})).toBe("Bash");
    expect(toolActivityText("Grep", { pattern: "foo" })).toBe("Grep"); // not a file/command field
    expect(toolActivityText("Edit", { file_path: "   " })).toBe("Edit"); // blank → no detail
  });

  it("returns empty string for a missing/blank tool name", () => {
    expect(toolActivityText("", { command: "ls" })).toBe("");
    expect(toolActivityText(undefined, {})).toBe("");
    expect(toolActivityText(123, {})).toBe("");
  });
});
