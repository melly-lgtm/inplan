// SPDX-License-Identifier: AGPL-3.0-or-later

import { describe, expect, it } from "vitest";
import { docPaths } from "../src/paths";

describe("docPaths", () => {
  it("computes sidecar paths under .inplan next to the file", () => {
    const p = docPaths("/work/project/design.plan.md");
    expect(p.controlDir).toBe("/work/project/.inplan");
    expect(p.logPath).toBe("/work/project/.inplan/design.plan.md.log.jsonl");
    expect(p.canonicalPath).toBe("/work/project/.inplan/design.plan.md.canonical.md");
    expect(p.backupsDir).toBe("/work/project/.inplan/design.plan.md.backups");
    expect(p.proposedPath).toBe("/work/project/.inplan/design.plan.md.proposed.md");
  });
});
