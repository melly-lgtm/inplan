// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Shared harness for the Electron e2e specs: launch the REAL app on a seeded plan doc under a
// throwaway INPLAN_HOME (so the first-run tour is skipped and settings start known), drive it via
// Playwright's _electron, and force-quit past the quit-confirmation dialog. These specs run against
// the genuine renderer (real CodeMirror / CSS / selection / IPC / navigation) — the surface the
// happy-dom unit suite can't reach. Run them through the GUI bridge (see the project notes).

import { _electron as electron, expect, type ElectronApplication, type Page } from "@playwright/test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO = process.cwd();

export interface LaunchOpts {
  /** The plan doc body+comment block. Defaults to a small multi-feature doc. */
  doc?: string;
  /** settings.json (merged over sane defaults). */
  settings?: Record<string, unknown>;
  /** Show the first-run tour instead of skipping it (default: skip). */
  showOnboarding?: boolean;
  /** Extra sibling files to write in the doc's directory (name → content). */
  files?: Record<string, string>;
  /** Extra env for the launch. */
  env?: Record<string, string>;
  /** Body text to await before returning (proves the editor rendered). Default: "alpha". */
  expectText?: string;
}

export interface Ctx {
  app: ElectronApplication;
  win: Page;
  dir: string;
  home: string;
  docPath: string;
  sidecarDir: string;
}

/** A doc with a heading, list, paragraphs (blank-line separated) + one anchored question thread. */
export const DEFAULT_DOC =
  "# E2E Plan\n\n" +
  "alpha beta alpha gamma — repeated words for find.\n\n" +
  "## Section A\n\n" +
  "- first list item\n- second list item\n- third list item\n\n" +
  "The [datastore choice](#cmt-q1) needs a decision.\n\n" +
  "Second paragraph, separated by a blank line.\n\n" +
  "<!--inplan v1\n" +
  JSON.stringify([
    {
      id: "cmt-q1",
      author: "Opus 4.8 <claude@inplan.ai>",
      date: "2026-01-01T00:00:00Z",
      resolved: false,
      text: "Which datastore?",
      question: { multiSelect: false, choices: [{ label: "Postgres", description: "JSONB + scale" }, { label: "SQLite", description: "simplest" }] },
    },
  ]) +
  "\n-->\n";

export async function launch(opts: LaunchOpts = {}): Promise<Ctx> {
  const dir = mkdtempSync(join(tmpdir(), "inplan-e2e-"));
  const home = join(dir, "home");
  const sidecarDir = join(dir, "sidecars");
  mkdirSync(home, { recursive: true });
  if (!opts.showOnboarding) writeFileSync(join(home, "state.json"), JSON.stringify({ onboarded: true }));
  writeFileSync(join(home, "settings.json"), JSON.stringify({ autoResolve: false, agentMode: "planning", telemetry: false, ...opts.settings }));
  const docPath = join(dir, "design.plan.md");
  writeFileSync(docPath, opts.doc ?? DEFAULT_DOC);
  for (const [name, content] of Object.entries(opts.files ?? {})) writeFileSync(join(dir, name), content);

  const app = await electron.launch({
    args: [`--user-data-dir=${join(dir, "userdata")}`, join(REPO, "packages/app"), docPath],
    executablePath: join(REPO, "node_modules/.bin/electron"),
    env: { ...process.env, INPLAN_HOME: home, INPLAN_SIDECAR_DIR: sidecarDir, ...opts.env },
  });
  const win = await app.firstWindow();
  // Trace the whole app context so a headless-CI failure is diagnosable (config `use.trace` can't
  // reach a hand-launched Electron app). Opt-in via CI or PWTRACE=1 locally; the trace is saved in
  // quit(). Best-effort — tracing must never break the run.
  if (tracingOn) await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true }).catch(() => {});
  if (!opts.showOnboarding) await expect(win.locator("body")).toContainText(opts.expectText ?? "alpha", { timeout: 15_000 });
  return { app, win, dir, home, docPath, sidecarDir };
}

/** Whether to record a Playwright trace (on in CI; opt in locally with PWTRACE=1). env values are
 *  strings, so match PWTRACE explicitly — otherwise PWTRACE=0/false would still be truthy. */
const tracingOn = Boolean(process.env.CI) || process.env.PWTRACE === "1" || process.env.PWTRACE === "true";

/** Force-exit past the quit-confirmation dialog (a graceful close() would hang on the dialog). */
export async function quit(app?: ElectronApplication): Promise<void> {
  // Save the trace before exiting (one zip per spec file, under test-results/ which CI uploads).
  // Whole block is try/catch'd so it's strictly best-effort: a synchronous mkdirSync throw (bad
  // perms, or a file named test-results) OR an async tracing.stop reject (app already crashed/closed)
  // must never fail the run. A random suffix avoids any same-millisecond filename collision.
  if (app && tracingOn) {
    try {
      mkdirSync("test-results", { recursive: true });
      const uniq = Math.random().toString(36).slice(2, 8);
      await app.context().tracing.stop({ path: join("test-results", `electron-trace-${Date.now()}-${uniq}.zip`) });
    } catch {
      /* best-effort — tracing never breaks the run */
    }
  }
  await app?.evaluate(({ app: a }) => a.exit(0)).catch(() => {});
  await app?.close().catch(() => {});
}

/** Switch to the N-pane layout (the toolbar exposes "1 pane"/"2 panes"/"3 panes" by title). */
export async function setPanes(win: Page, n: 1 | 2 | 3): Promise<void> {
  await win.getByTitle(n === 1 ? "1 pane" : `${n} panes`).click();
}

/** The doc's control-log events (the app's ground-truth record of every action). Globs the single
 *  sidecar under INPLAN_SIDECAR_DIR. Empty until the editor has written its first entry. */
export function readLog(ctx: Ctx): Array<{ type: string; actor: string; payload?: unknown }> {
  const root = ctx.sidecarDir;
  if (!existsSync(root)) return [];
  for (const key of readdirSync(root)) {
    const p = join(root, key, "log.jsonl");
    if (!existsSync(p)) continue;
    // A read mid-write can catch a partially-flushed trailing line; skip any line that
    // doesn't parse rather than throwing (waitForEvent polls while the app is writing).
    return readFileSync(p, "utf8")
      .split("\n")
      .filter(Boolean)
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as { type: string; actor: string; payload?: unknown }];
        } catch {
          return [];
        }
      });
  }
  return [];
}

/** Poll the control log until an event of `type` appears (or time out), returning it. */
export async function waitForEvent(ctx: Ctx, type: string, timeoutMs = 5000): Promise<{ type: string; actor: string; payload?: unknown }> {
  const start = Date.now();
  for (;;) {
    const hit = readLog(ctx).find((e) => e.type === type);
    if (hit) return hit;
    if (Date.now() - start > timeoutMs) throw new Error(`control-log event "${type}" not seen within ${timeoutMs}ms (saw: ${readLog(ctx).map((e) => e.type).join(",")})`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
