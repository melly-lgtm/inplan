// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Formatting for the agent-console relay's tool-activity lines. Kept in its own module so it's
// unit-testable — cli.ts runs main() on import, so its exports can't be imported from a test.

const CAP = 30;
const head = (s: string): string => (s.length > CAP ? s.slice(0, CAP) + "…" : s); // keep the start (commands)
const tail = (s: string): string => (s.length > CAP ? "…" + s.slice(s.length - CAP) : s); // keep the end (file names)

/** A terse tool-activity label for the agent console so it shows *what happened*, not just the
 *  tool name: **Bash** appends the first 30 chars of the command; **Edit/Write/Read/…** append
 *  the file (path tail, so the filename stays visible). Other tools stay name-only. Returns ""
 *  when there's no usable tool name. */
export function toolActivityText(toolName: unknown, toolInput: unknown): string {
  const name = typeof toolName === "string" ? toolName.trim() : "";
  if (!name) return "";
  const input = toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  if (name === "Bash") {
    const cmd = s(input.command).replace(/\s+/g, " ");
    return cmd ? `${name}: ${head(cmd)}` : name;
  }
  const file = s(input.file_path) || s(input.notebook_path) || s(input.path);
  return file ? `${name}: ${tail(file)}` : name;
}
