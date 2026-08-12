#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  type ControlChannel,
  CONTROL_LOG_VERSION,
  type DocStatus,
  type DocumentStore,
  FsControlChannel,
  FsDocumentStore,
  hashBody,
  type LogEntry,
  LogEventType,
  parse,
  readGlobalSettings,
  readLog,
  readStatus,
  settingsFromEntries,
  writeStatus,
} from "@inplan/core/node";
import { agentAuthorFor } from "./agentAuthor";
import { gitProvenance } from "./provenance";
import { authedSession, clearAuth, currentUser, liveRemoteBackend, loadAuth, remoteBackend, saveAuth, type AuthFile } from "./cliAuth";
import { SupabaseDocumentStore } from "@inplan/backend-supabase";
import { LoginSessionExpiredError, clearPendingLogin, createLoginSession, loadPendingLogin, pollLoginSession, rendezvousLogin, type PendingLogin } from "./cliLogin";
import { resolveIdentity, setManualProfile, writeLocalProfile } from "./cliProfile";
import { checkForUpdate, selfUpdate, UPDATE_PKG, warnIfOutdated } from "./update";
import { runningEditorPid } from "./editorProcess";
import { applyGatedEdit } from "./applyEdit";
import { evaluateAgentEdit } from "./gate";
import { addComment, AddCommentError } from "./commentAdd";
import { docPaths, sidecarRoot, type DocPaths } from "./paths";
import { loadPluginGate, loadPluginGateOutcome, resolveHubUrl, type PluginAbsenceReason, type PluginGate } from "./pluginGate";
import { demoteSource, shouldHydrateWorkFile, pendingRequiresReplay, postTurnAction, trackGateDegradations, type WaitOutcome } from "./liveSync";
import { announcePresence } from "./presence";
import { awaitReopen, wakePredicate, waitForActions } from "./wait";
import { versionFromModule } from "./version";
import { toolActivityText } from "./relayActivity";
import { ensureDocFile } from "./ensureDoc";
import { trackCli } from "./telemetry";

// Version is read from the adjacent package.json (see ./version) so a release bumps one place.
const VERSION = versionFromModule(import.meta.url);

function output(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

/**
 * Schedule an exit that waits for stdout to drain.
 *
 * Node's stdout is ASYNCHRONOUS when piped — the normal case, since the CLI runs as a coding agent's
 * subprocess — and `process.exit()` discards whatever is still buffered. An `output(...)` immediately
 * followed by `process.exit(n)` therefore delivers the exit code with no payload: exactly the
 * machine-readable status these coded exits exist to carry. Stream writes are ordered, so this
 * zero-length write's callback runs only once everything queued before it has been flushed.
 *
 * BOTH streams are drained. stderr is buffered when piped too, so draining stdout alone could still
 * drop the human-facing explanation — on the deny paths that message is the *only* thing telling
 * someone how to fix their situation.
 *
 * Callers MUST `return` straight after: this SCHEDULES the exit, it does not perform it.
 */
export function exitAfterFlush(
  code: number,
  out: Pick<NodeJS.WriteStream, "write"> = process.stdout,
  exit: (c: number) => void = process.exit,
  err: Pick<NodeJS.WriteStream, "write"> = process.stderr,
): void {
  out.write("", () => err.write("", () => exit(code)));
}

function getFlag(args: string[], name: string): string | undefined {
  const withEq = args.find((a) => a.startsWith(`--${name}=`));
  if (withEq) return withEq.slice(name.length + 3);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1]!.startsWith("--")) return args[idx + 1];
  return undefined;
}

function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

/**
 * Result of locating the Electron editor bundled alongside this CLI in the published
 * `inplan` package (layout: `bin/cli.js` + `app/main/index.cjs`, with `electron` as a
 * dependency): ready-to-launch, no-bundled-app (source/dev), or app-present-but-no-runtime
 * (e.g. electron's binary never downloaded). spawnApp turns each into the right action/message.
 */
type BundledApp =
  | { electron: string; appMain: string } // ready to launch
  | { appMain: null } // no bundled app (running from source/dev)
  | { appMain: string; error: string }; // app present, but its Electron runtime is unavailable

/** Electron's binary path relative to its package's `dist/` — matches electron's own index.js
 *  (`join(pkgDir, "dist", <name>)`). win32: electron.exe; darwin: the .app's MacOS binary. */
function electronDistRel(platform: NodeJS.Platform): string {
  if (platform === "win32") return "electron.exe";
  if (platform === "darwin") return join("Electron.app", "Contents", "MacOS", "Electron");
  return "electron";
}

/** Locate electron's binary on disk even when `path.txt` is absent. `require("electron")` reads
 *  path.txt (written by electron's postinstall) and THROWS if it's missing — but the binary can be
 *  present anyway (a proxy/AV blocked the download so postinstall never finished, and the user
 *  extracted the zip by hand — a common Windows case). Probe `dist/<bin>` directly, and self-heal
 *  by writing path.txt so the normal require works from then on. Null when there's truly no binary. */
function electronBinaryFromDisk(reqUrl: string): string | null {
  try {
    const pkgDir = dirname(createRequire(reqUrl).resolve("electron/package.json"));
    const rel = electronDistRel(process.platform);
    const bin = join(pkgDir, "dist", rel);
    if (!existsSync(bin)) return null;
    try {
      const pathFile = join(pkgDir, "path.txt");
      if (!existsSync(pathFile)) writeFileSync(pathFile, rel); // self-heal for next time
    } catch {
      /* best-effort — we already have the path to return */
    }
    return bin;
  } catch {
    return null; // electron not installed at all
  }
}

/** @electron/get's default download cache dir (env-paths' "electron" app cache — verified against
 *  this dependency's actual behavior, not guessed). Keyed by a content-hash subdirectory, not the
 *  version, so the zip has to be searched for by filename rather than addressed directly. */
function electronCacheDir(): string {
  if (process.platform === "win32") return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "electron", "Cache");
  if (process.platform === "darwin") return join(homedir(), "Library", "Caches", "electron");
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "electron");
}

/** The most-recently-modified cached zip matching this version/platform/arch, if any. install.js
 *  already downloaded + checksum-verified it via `@electron/get` even on a run where extraction
 *  ultimately left no binary behind — so re-extracting it costs no network round-trip. */
function cachedElectronZip(version: string, platform: NodeJS.Platform, arch: string): string | null {
  const root = electronCacheDir();
  const want = `electron-v${version}-${platform}-${arch}.zip`;
  try {
    let best: { file: string; mtime: number } | null = null;
    for (const sub of readdirSync(root)) {
      const f = join(root, sub, want);
      if (!existsSync(f)) continue;
      const mtime = statSync(f).mtimeMs;
      if (!best || mtime > best.mtime) best = { file: f, mtime };
    }
    return best?.file ?? null;
  } catch {
    return null;
  }
}

/** Windows-only fallback extraction: PowerShell's `Expand-Archive` instead of electron's own
 *  extract-zip. Observed on a real machine: extract-zip's streamed per-entry writes reliably left
 *  every file in the zip on disk EXCEPT electron.exe (the one actual executable — every DLL,
 *  locale, and data file extracted fine), while Expand-Archive (a different, .NET-based extraction
 *  path) left it intact every time. The exact interceptor was never confirmed (Defender's own
 *  detection log had no record of it on that machine), but the extractor swap is independently
 *  reproducible, so it's used as a fallback rather than a replacement.
 *  Paths are passed via env vars, not interpolated into the -Command string, so a literal
 *  apostrophe in a path (e.g. `C:\Users\O'Neil\...`) can't break it. (PowerShell's `$args` isn't
 *  an option here: unlike `-File script.ps1 arg1 arg2`, trailing argv after an inline `-Command
 *  "..."` doesn't bind to `$args` — confirmed by a direct repro, not assumed.) */
function expandArchiveWindows(zipPath: string, destDir: string): boolean {
  const r = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", "Expand-Archive -LiteralPath $env:INPLAN_ZIP_PATH -DestinationPath $env:INPLAN_DEST_DIR -Force"],
    { stdio: "ignore", env: { ...process.env, INPLAN_ZIP_PATH: zipPath, INPLAN_DEST_DIR: destDir } },
  );
  return r.status === 0;
}

/** When electron's binary is missing — its postinstall download was interrupted somehow, so
 *  `dist/electron(.exe)` + path.txt never got written — re-run electron's OWN installer
 *  (`install.js`) to retry the download, then (Windows only) re-extract it a different way if the
 *  binary still didn't land. This automates the manual "rebuild electron" fix.
 *
 *  Deliberately does NOT default to a third-party mirror: an explicit `ELECTRON_MIRROR` (the user's
 *  own choice) is honored via the inherited env, but nothing here silently substitutes one. A real
 *  Windows repro confirmed the actual failure isn't GitHub being unreachable — the download
 *  completes and passes electron's own checksum check either way — so retrying the SAME (default)
 *  host plus the extractor swap below is enough on its own; a mirror would only help the separate,
 *  unconfirmed case of GitHub genuinely being blocked, which isn't worth the implicit trust shift.
 *
 *  Best-effort: returns true only if the binary is present afterward; any failure returns false so
 *  the caller falls back to headless. Skipped when INPLAN_NO_ELECTRON_DOWNLOAD=1 (air-gapped/CI —
 *  the attempt would just be slow). */
function autoInstallElectron(reqUrl: string): boolean {
  if (process.env.INPLAN_NO_ELECTRON_DOWNLOAD === "1") return false;
  try {
    const pkgDir = dirname(createRequire(reqUrl).resolve("electron/package.json"));
    const installJs = join(pkgDir, "install.js");
    if (!existsSync(installJs)) return false;
    process.stderr.write("[inplan] editor runtime missing — retrying the download …\n");
    execFileSync(process.execPath, [installJs], { cwd: pkgDir, stdio: "inherit", env: process.env });
    if (electronBinaryFromDisk(reqUrl) !== null) return true;
    // The download succeeded (electron's own checksum check would have thrown otherwise) but its
    // extractor left no binary behind — re-extract the same already-verified zip a different way.
    if (process.platform === "win32") {
      const { version } = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")) as { version: string };
      const zip = cachedElectronZip(version, "win32", process.env.npm_config_arch || process.arch);
      if (zip && expandArchiveWindows(zip, join(pkgDir, "dist"))) {
        writeFileSync(join(pkgDir, "path.txt"), "electron.exe");
      }
    }
    return electronBinaryFromDisk(reqUrl) !== null;
  } catch {
    return false;
  }
}

function resolveBundledApp(): BundledApp {
  const here = dirname(fileURLToPath(import.meta.url));
  const appMain = join(here, "..", "app", "main", "index.cjs");
  if (!existsSync(appMain)) return { appMain: null }; // source/dev — no sibling app/
  // require("electron") returns the binary path, but THROWS ("Electron failed to install
  // correctly") whenever path.txt is missing — even if the binary is actually on disk. So treat
  // any failure (or a stale/nonexistent path) as inconclusive and fall back to a direct disk probe.
  try {
    const electron = createRequire(import.meta.url)("electron") as unknown;
    if (typeof electron === "string" && electron && existsSync(electron)) return { electron, appMain };
  } catch {
    /* fall through to the disk probe */
  }
  const onDisk = electronBinaryFromDisk(import.meta.url);
  if (onDisk) return { electron: onDisk, appMain };
  return { appMain, error: "Electron's binary isn't installed — its download was likely blocked (proxy/AV), and path.txt is missing" };
}

function spawnApp(file: string): number | null {
  const env = { ...process.env, INPLAN_CLI: process.argv[1] ?? "" };
  // Prefer an explicit override (dev: points at electron-vite or a chosen Electron).
  const override = process.env.INPLAN_APP_CMD;
  if (override) {
    const child = spawn(override, [file], { detached: true, stdio: "ignore", shell: true, env });
    child.unref();
    return child.pid ?? null;
  }
  // Otherwise launch the editor bundled in the published package via its electron dependency.
  const bundled = resolveBundledApp();
  if ("electron" in bundled) {
    // Pass our own entry path so the editor can shell back to the CLI for the cloud
    // actions (whoami / upload / logout / token) it surfaces in the profile menu.
    const child = spawn(bundled.electron, [bundled.appMain, file], { detached: true, stdio: "ignore", env });
    child.unref();
    return child.pid ?? null;
  }
  // App present but its Electron runtime is missing (the download was blocked). Try electron's own
  // installer once via a mirror, then re-resolve — turning the manual "set ELECTRON_MIRROR + rebuild"
  // fix into an automatic one. Any failure falls through to the headless guidance below.
  if (bundled.appMain !== null && "error" in bundled && autoInstallElectron(import.meta.url)) {
    const retry = resolveBundledApp();
    if ("electron" in retry) {
      const child = spawn(retry.electron, [retry.appMain, file], { detached: true, stdio: "ignore", env });
      child.unref();
      return child.pid ?? null;
    }
  }
  // No editor — surface WHY (not just "no editor"), so the failure is actionable. Also report it
  // (opt-in, anonymous): the app never starts here, so this is the only place the launch failure
  // is observable — a high-value install-health signal (proxy/AV blocking the Electron download).
  const telemetryOn = readGlobalSettings().telemetry === true;
  if (bundled.appMain === null) {
    trackCli("editor_launch_failed", telemetryOn, { reason: "no_bundled_editor" });
    process.stderr.write("[inplan] no bundled editor (running from source?) — set INPLAN_APP_CMD to your editor; running headless\n");
  } else {
    trackCli("editor_launch_failed", telemetryOn, { reason: "electron_unavailable" });
    // The literal install dir (not a shell expansion like $(npm root -g), which doesn't
    // exist on Windows cmd) so the fix command is copy-pasteable on any OS.
    const root = resolve(dirname(bundled.appMain), "..", "..");
    process.stderr.write(
      `[inplan] the bundled editor's Electron runtime is unavailable: ${bundled.error}\n` +
        `  → re-download the binary:  npm rebuild electron --prefix "${root}"\n` +
        `     If a proxy/firewall blocks the download, set a mirror first, e.g.\n` +
        `       ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   (macOS/Linux)\n` +
        `       set ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/   (Windows cmd)\n` +
        `     Or point INPLAN_APP_CMD at an Electron that launches the app, e.g.\n` +
        `       INPLAN_APP_CMD="electron '${bundled.appMain}'"\n` +
        `  Running headless for now.\n`,
    );
  }
  return null;
}

/** The doc's current collaboration mode from the protocol history. The CLI is mode-agnostic: it
 *  reads the gate policy (wake/lock) the editor recorded into the latest mode_changed, never a
 *  specific mode by name. Defaults to the turn-taking policy (the open-core built-in). */
function modeFrom(entries: LogEntry[]): { cadence: string; wake: "turn-end" | "any-action"; locksEditor: boolean } {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.ModeChanged) {
      const p = entries[i]!.payload as { cadence?: string; wake?: string; locksEditor?: boolean } | undefined;
      const wake = p?.wake === "any-action" ? "any-action" : "turn-end";
      return {
        cadence: typeof p?.cadence === "string" ? p.cadence : "turn",
        wake,
        // Fall back from the wake policy when an older event lacks locksEditor: turn-end locks.
        locksEditor: typeof p?.locksEditor === "boolean" ? p.locksEditor : wake === "turn-end",
      };
    }
  }
  return { cadence: "turn", wake: "turn-end", locksEditor: true };
}

/** Agent-change acceptance — a **global** setting (settings.json), read fresh each turn via
 *  settingsFromEntries (global file + this session's settings_changed), default "review". */
function acceptanceFrom(entries: LogEntry[]): "auto" | "review" {
  return settingsFromEntries(entries).acceptance === "auto" ? "auto" : "review";
}

/** The highest seq in the protocol history (0 if empty). */
function maxSeqFrom(entries: LogEntry[]): number {
  return entries.length ? entries[entries.length - 1]!.seq : 0;
}

/**
 * A document's control channel + store, plus storage-agnostic providers for the
 * protocol history and exit logging. The desktop edition backs this with sidecar
 * files; the cloud edition backs it with Supabase — `waitCycle` runs unchanged
 * over either, since it consumes only the {@link ControlChannel}/{@link DocumentStore}
 * interfaces.
 */
export interface WaitBackend {
  channel: ControlChannel;
  store: DocumentStore;
  /** Full protocol history, for deriving cadence/acceptance/settings/start cursor. */
  history(): Promise<LogEntry[]>;
  /** Record why a waiter exited (sidecar file on the desktop; no-op for cloud). */
  logExit(reason: string): void;
  /** Handle a `save_locally_requested` directive (cloud→local handoff). When set
   *  and that event wakes the wait, this runs instead of the normal status output
   *  and is responsible for emitting its own result. Absent on the desktop. */
  onSaveLocally?: () => Promise<void>;
}

/** Local sidecar-file backend for a document on disk. */
function fsBackend(file: string): WaitBackend {
  const p = docPaths(file);
  mkdirSync(p.controlDir, { recursive: true });
  return {
    channel: new FsControlChannel(p),
    store: new FsDocumentStore(p),
    history: async () => readLog(p.logPath),
    logExit: (reason) => logWaitExit(p, reason),
  };
}

/** Record why a waiter exited (normal status / superseded / OS signal), for debugging
 *  the "waiter vanished" reports — a reaped process leaves a `signal:*` line here. */
function logWaitExit(p: DocPaths, reason: string): void {
  try {
    appendFileSync(p.waitDebugPath, `${new Date().toISOString()} pid=${process.pid} ${reason}\n`);
  } catch {
    /* best-effort */
  }
}

/**
 * Evaluate the agent's edit (gate), accept it as canonical, then block for user
 * actions. The cursor is self-managed: an explicit override, else the persisted
 * cursor, else "start from now" (current max). It is persisted on return so the
 * agent never hand-manages it and turns can't be skipped.
 */
export async function waitCycle(backend: WaitBackend, explicitCursor: number | null, confirmed: Set<string>, model?: string, gate: PluginGate | null = null): Promise<WaitOutcome> {
  const { channel, store } = backend;
  const history = await backend.history();

  // Cursor: explicit override, else the persisted cursor, else "start from now".
  // getCursor() returns 0 when unset, so `|| maxSeqFrom` means begin at the latest seq.
  const cursor = explicitCursor ?? ((await channel.getCursor()) || maxSeqFrom(history));

  const current = await store.loadDoc();

  // The gate's canonical base: the plugin's projection when an entitled plugin is active (the editor
  // published a session for this doc — the plugin owns it, so we apply through it, never writing the
  // .md). A plugin read failure (editor closed / unreachable) falls back to the file model. Without
  // a plugin it's the persisted canonical (seeded from the file on first run).
  let usePlugin = false;
  let canonicalText: string;
  if (gate) {
    try {
      canonicalText = await gate.readCanonical();
      usePlugin = true;
    } catch {
      canonicalText = (await store.getCanonical()) ?? current;
    }
  } else {
    const persisted = await store.getCanonical();
    if (persisted === null) {
      canonicalText = current;
      await store.setCanonical(current);
    } else {
      canonicalText = persisted;
    }
  }

  const ev = evaluateAgentEdit(canonicalText, current, confirmed);
  if (ev.unconfirmed.length > 0) {
    output({
      status: "confirm_required",
      message: "Edit removes anchored comment(s). Re-run wait with --confirmed-comment-deletion=<ids> to proceed.",
      lost: ev.unconfirmed.map((c) => ({ id: c.id, text: c.text, author: c.author })),
    });
    exitAfterFlush(3);
    return "exiting";
  }
  if (!ev.integrityOk) {
    output({ status: "integrity_error", errors: ev.integrityErrors });
    exitAfterFlush(2);
    return "exiting";
  }
  // In Review mode an agent **body** change is quarantined as a proposal rather
  // than applied: the working file + canonical stay put, the agent's version is
  // parked in `.proposed.md`, and `agent_revision_proposed` is logged. The human
  // accepts/rejects in the editor (which then writes canonical). This makes the
  // file the source of truth WITHOUT auto-applying — killing the app before a
  // decision leaves the proposal pending, never silently accepted.
  const acceptance = acceptanceFrom(history);
  const quarantine = acceptance === "review" && parse(canonicalText).body !== parse(current).body;
  // `usePlugin ? gate : null` — only route through the plugin when its read succeeded.
  await applyGatedEdit(store, channel, ev, { current, canonicalText, quarantine, gate: usePlugin ? gate : null });

  // Signal the agent has (re)engaged this round so the editor can clear its
  // "Agent is thinking…" indicator even when the agent made no body change.
  await channel.append({ actor: "agent", type: LogEventType.AgentRevised });

  // ── Everything below only READS, WAITS, and REPORTS. ──────────────────────────────────────────
  //
  // The turn processing above ran exactly once; the wait below may cycle through any number of
  // editor reloads without coming back up here. A reopen-resume is a `continue`, not a recursive
  // call — and that STRUCTURE, not a guard, is what enforces the reopen invariants that were being
  // patched one review round at a time:
  //   • a resume cannot re-run the edit pipeline. Under recursion every reload re-appended
  //     agent_revised, and on the PLUGIN path — where quarantine does not revert the working copy
  //     to canonical — a pending Review proposal was re-parked and agent_revision_proposed
  //     re-appended, duplicating agent events the editor renders;
  //   • a resume cannot re-claim or re-mint the lock, so a stale waiter returning from a grace can
  //     only DISCOVER it lost — waitForActions polls isSuperseded(lockToken) every tick — never
  //     overwrite the newer waiter's token, and it mutates nothing on the way to finding out;
  //   • the signal handlers are registered once, so repeated reloads cannot leak listeners.

  // Single-waiter lock: claim the doc so any older waiter steps down (no racing double-waiters).
  // Last writer wins — any older waiter sees the token change and steps down. Log the exit reason —
  // including OS signals — so a reaped waiter is diagnosable instead of "vanishing" silently.
  const lockToken = `${process.pid}-${Date.now()}`;
  await channel.claimLock(lockToken);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(sig, () => {
      backend.logExit(`signal:${sig}`);
      process.exit(0);
    });
  }

  const debounceMs = Number(process.env.INPLAN_DEBOUNCE_MS ?? 3000);
  const pollMs = Number(process.env.INPLAN_POLL_MS ?? 200);

  let waitCursor = cursor;
  let historyForMode = history;
  for (;;) {
    // Mode-aware wake from the recorded policy: a turn-end mode wakes only on turn-end /
    // session-close; an any-action mode wakes on any user action. Re-derived each iteration
    // (history is re-read on resume), so a mode switched just before the reload is honoured.
    const mode = modeFrom(historyForMode);
    const isActionable = wakePredicate(mode.wake);
    const result = await waitForActions({ channel, cursor: waitCursor, debounceMs, pollMs, isActionable, token: lockToken });

    // The wait gave up after a streak of failed polls — an expired session is the common cause.
    // Report it as a status the agent can act on and exit non-zero. It used to reach here as an
    // unhandled rejection that killed the process mid-poll: a stack trace on stderr, nothing on stdout.
    if (result.failed) {
      backend.logExit("poll_failed");
      process.stderr.write(`inplan: lost contact with the document (${result.failed.message}).\n  If your session expired, run \`inplan login\` and re-attach.\n`);
      output({ status: "wait_failed", message: result.failed.message });
      exitAfterFlush(EXIT_WAIT_FAILED);
      return "exiting";
    }

    // Superseded: a newer waiter owns the doc now. Step down quietly without
    // advancing the cursor (the live waiter handles it).
    if (result.superseded) {
      backend.logExit("superseded");
      output({ status: "superseded" });
      return "ok";
    }

    // Cloud→local handoff: a human on the web asked us to bring the doc back to disk.
    // The backend's handler downloads + relocates + flips status and emits its own
    // result, so we hand off instead of printing the normal turn status. Do this BEFORE advancing
    // the cursor: if the handler throws (e.g. the gate path's hub read fails), the
    // SaveLocallyRequested event stays unconsumed so the next run retries — otherwise the handoff
    // would be lost. On success the doc becomes local, so the cloud cursor is moot.
    if (backend.onSaveLocally && result.entries.some((e) => e.type === LogEventType.SaveLocallyRequested)) {
      backend.logExit("save_locally");
      await backend.onSaveLocally();
      return "ok";
    }

    await channel.setCursor(result.cursor); // advance the persisted cursor so the next call continues here

    // In-window navigation: the editor followed a link to a sibling doc and parked a
    // `navigated_to {path}`. Step down here and report the new path so the agent loop
    // re-attaches there (`wait <path>`), following the human across docs.
    const navEntry = result.entries.find((e) => e.type === LogEventType.NavigatedTo);
    if (navEntry) {
      const path = (navEntry.payload as { path?: string } | undefined)?.path;
      backend.logExit("navigated");
      output({ status: "navigated", ...(path ? { path } : {}), cursor: result.cursor, closed: false });
      return "ok";
    }

    // The editor logs WHY it closed (completed / window_closed); a crash logs nothing. The LAST
    // close is the terminal one: a batch may hold window_closed (a reload) followed by completed
    // (the human came back and did the build handoff) — grace must key on the final word, not
    // delay an explicit handoff by three minutes.
    const closeEntry = [...result.entries].reverse().find((e) => e.type === LogEventType.SessionClosed);
    // A `window_closed` is routinely just a page RELOAD — the web editor tears down (logging the
    // close) and is back seconds later — or a stray second surface (an old desktop window) closing
    // while the live session goes on. Exiting on that signal alone strands the returning human
    // with no agent attached, and nothing restarts the wait. So: linger, and if the human shows
    // signs of being back within the grace (a new user action, or the editor presence heartbeat
    // returning), loop back to waiting as if the close never happened. An explicit `completed`
    // (the build handoff) still ends the session immediately, and a NEWER waiter supersedes this
    // one mid-grace exactly as it would mid-wait.
    if (closeEntry && ((closeEntry.payload as { reason?: string } | undefined)?.reason ?? "completed") === "window_closed") {
      // The editor may already be demonstrably back: a debounced batch can carry the close AND the
      // user actions that followed it. Waiting out the grace in that case reports a live editor as
      // closed minutes later, on evidence we are holding. Resume from the CLOSE, not from
      // `result.cursor` — the cursor is this batch's max seq, so the very actions that proved the
      // editor is back sit at or below it and would be skipped, silently dropping the user's work.
      if (result.entries.some((e) => e.seq > closeEntry.seq && e.actor === "user" && e.type !== LogEventType.SessionClosed)) {
        process.stderr.write("inplan: the editor closed and is already active again — resuming the wait.\n");
        waitCursor = closeEntry.seq;
        historyForMode = await backend.history();
        continue;
      }
      process.stderr.write("inplan: the editor closed — often just a page reload. Watching for it to come back…\n");
      const reopen = await awaitReopen(channel, result.cursor, { token: lockToken });
      if (reopen.kind === "superseded") {
        backend.logExit("superseded");
        output({ status: "superseded" });
        return "ok";
      }
      if (reopen.kind === "completed") {
        // An explicit build handoff arrived mid-grace: end now, with ITS reason, not window_closed.
        // Persist the GRACE read's cursor and report its entries — the cursor was advanced before
        // the grace began, so reporting the pre-grace one would leave the terminating SessionClosed
        // unrecorded and the next wait would re-read and re-report the completed session.
        await channel.setCursor(reopen.cursor);
        backend.logExit(reopen.reason);
        output({ status: "closed", reason: reopen.reason, cursor: reopen.cursor, closed: true, entries: [...result.entries, ...reopen.entries] });
        return "ok";
      }
      // A grace reopen deliberately resumes from the PRE-grace cursor: the user entries that proved
      // the return are then re-read by the next iteration and handled as the actionable wake they are.
      if (reopen.kind === "reopened") {
        process.stderr.write("inplan: the editor is back — resuming the wait.\n");
        waitCursor = result.cursor;
        historyForMode = await backend.history();
        continue;
      }
      process.stderr.write("inplan: the editor did not come back — treating the session as closed.\n");
    }

    // One status per situation:
    //   your_turn — Turn mode: human finished their turn and is LOCKED; revise, then
    //               call wait to hand control back.
    //   activity  — Instant mode: human is editing LIVE and is NOT blocked.
    //   closed    — the session ended; stop. `reason` says how: completed / window_closed
    //               / crashed_or_killed.
    let status: string;
    let reason: string | undefined;
    if (closeEntry) {
      status = "closed";
      reason = (closeEntry.payload as { reason?: string } | undefined)?.reason ?? "completed";
    } else if (result.editorGone) {
      status = "closed";
      reason = "crashed_or_killed";
    } else {
      // A locking mode means the human's editor is locked waiting for the agent (your_turn);
      // a non-locking (live) mode means they keep editing (activity).
      status = mode.locksEditor ? "your_turn" : "activity";
    }
    backend.logExit(`status:${status}${reason ? `/${reason}` : ""}`);
    output({
      status,
      mode: mode.cadence,
      humanLocked: status === "your_turn",
      // Materialized current settings (global file + this session's settings_changed),
      // so the agent always has them without scanning the log history.
      settings: settingsFromEntries(historyForMode),
      // The canonical name the agent should author comments under (model-qualified
      // when --model was passed), so presence + authorship stay consistent.
      agentAuthor: agentAuthorFor(model),
      ...(reason ? { reason } : {}),
      cursor: result.cursor,
      closed: status === "closed",
      entries: result.entries,
    });
    return "ok";
  }
}

/**
 * Sign in to the cloud. Two paths:
 *  - Interactive (default): `inplan login` runs the cloud-rendezvous handoff (cliLogin.ts) —
 *    open /cli-auth?session=…#pub=…, the page seals the credentials to our ephemeral key and
 *    posts them to the session, we poll and decrypt. Non-interactive callers get a pending
 *    sidecar + EXIT_LOGIN_PENDING instead, and the next invocation resumes it.
 *  - Non-interactive: when `--url`/`--anon`/`--refresh` (or the matching env vars) are all
 *    supplied, store them directly — for scripts and the desktop app, which already hold a
 *    session. Flags win over env so a shell can pre-seed the deployment and pass only `--refresh`.
 *    The refresh token can come via `INPLAN_REFRESH_TOKEN` to keep it out of argv (where `ps`
 *    would expose it).
 */
async function doLogin(args: string[]): Promise<void> {
  // `--help` prints usage and exits BEFORE any rendezvous/sidecar work — asking how to sign in must
  // never mint a login session or touch the ~/.inplan lock.
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(
      "inplan login — sign in to the cloud\n" +
        "  inplan login                                              browser rendezvous handoff (interactive)\n" +
        "  inplan login --url <URL> --anon <KEY> --refresh <TOKEN> [--email <EMAIL>]\n" +
        "                                                           store credentials directly (scripts / desktop)\n" +
        "  env equivalents: INPLAN_SUPABASE_URL, INPLAN_SUPABASE_ANON_KEY, INPLAN_REFRESH_TOKEN\n",
    );
    return;
  }
  const url = getFlag(args, "url") ?? process.env.INPLAN_SUPABASE_URL;
  const anonKey = getFlag(args, "anon") ?? process.env.INPLAN_SUPABASE_ANON_KEY;
  const refreshToken = getFlag(args, "refresh") ?? process.env.INPLAN_REFRESH_TOKEN;
  const email = getFlag(args, "email");

  if (url && anonKey && refreshToken) {
    // Non-interactive: all credentials supplied → store them as-is.
    saveAuth({ url, anonKey, refreshToken, ...(email ? { email } : {}) });
    // Capture the cloud account's identity locally so comments are authored as the
    // signed-in user (overrides any earlier git/manual profile on explicit login).
    await persistCloudIdentity();
    output({ status: "logged_in", url, ...(email ? { email } : {}) });
    return;
  }

  // Browser handoff (cloud rendezvous). No partial-credential mode: anything short of the full
  // non-interactive set above falls through here, which is the intended UX.
  //
  // Explicit opt-outs first — BEFORE resuming or minting any session: an unattended run must use
  // the non-interactive credential path above, never wait on a human (even on a stale sidecar),
  // and never leave a dangling rendezvous session nobody will complete.
  if (loginOptOut(args)) {
    process.stderr.write("inplan login: non-interactive environment — pass --url/--anon/--refresh (or the matching INPLAN_* env vars).\n");
    process.exit(1);
  }
  // Non-interactive callers (coding agents, pipes): resume a pending session a previous
  // invocation minted — the agent loop's second half — or mint one and exit pending.
  // A human at a TTY who set INPLAN_NO_BROWSER is still INTERACTIVE — they just don't want a
  // popup. Route them to the inline flow with the auto-open disabled (URL printed, poll inline)
  // instead of the agent's pending-exit, which would block on a stale sidecar or exit 7 with
  // nothing polling.
  const noBrowserHuman =
    !canInteractiveLogin(args) &&
    Boolean(process.env.INPLAN_NO_BROWSER) &&
    Boolean(process.stdin.isTTY && process.stdout.isTTY) &&
    !process.env.CI &&
    !isKnownAgentEnv();
  if ((!canInteractiveLogin(args) && !noBrowserHuman) || isKnownAgentEnv()) {
    const pending = await loadPendingLogin();
    if (pending) {
      try {
        process.stderr.write(`inplan: waiting for the pending browser sign-in to finish…\n  ${pending.url}\n`);
        const auth = await pollLoginSession(pending, { onNudge: printLoginNudge });
        saveAuth(auth);
        await persistCloudIdentity();
        output({ status: "logged_in", url: auth.url, ...(auth.email ? { email: auth.email } : {}) });
        return;
      } catch (e) {
        if (!(e instanceof LoginSessionExpiredError)) {
          process.stderr.write(`inplan login: ${e instanceof Error ? e.message : String(e)}\n`);
          process.exit(1);
        }
        /* expired → fall through to a fresh pending session */
      }
    }
    await pendingLoginExit();
    // pendingLoginExit only returns when the session could not be minted (offline / hub down):
    // no credentials were stored, so this login FAILED — exit 1 like every other failure path
    // (returning here would exit 0 and a script branching on the code would think it signed in).
    process.exit(1);
  }
  // An interactive human explicitly running `inplan login` means "sign me in NOW": don't block
  // for minutes on a leftover-but-still-valid pending session from an aborted agent flow they may
  // never have seen — drop it and mint fresh. (Auto-login's ensureLoggedIn still resumes first,
  // which is the right default for the agent loop's re-run.)
  clearPendingLogin();
  try {
    const auth = noBrowserHuman
      ? await rendezvousLogin({
          onUrl: (u) => process.stderr.write(`Open this URL in your browser to sign in:\n  ${u}\n`),
          onNudge: printLoginNudge,
          open: () => {}, // INPLAN_NO_BROWSER: never launch one — the printed URL is the flow
        })
      : await defaultRendezvousLogin();
    saveAuth(auth);
    await persistCloudIdentity();
    output({ status: "logged_in", url: auth.url, ...(auth.email ? { email: auth.email } : {}) });
  } catch (e) {
    process.stderr.write(`inplan login: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

/** Best-effort: write the signed-in cloud account's name/email to the local profile. */
async function persistCloudIdentity(): Promise<void> {
  try {
    const user = await currentUser();
    const name = (user?.name && user.name.trim()) || (user?.email && user.email.trim());
    if (name) writeLocalProfile({ name, ...(user?.email ? { email: user.email } : {}), source: "cloud" });
  } catch {
    /* offline / session not yet usable — resolveIdentity will fill it in later */
  }
}

/**
 * May we open a browser to sign in on the user's behalf? Auto-login is a foreground
 * convenience for a human at a terminal — never for a background agent hook, a CI job,
 * or a piped/headless invocation, where popping a browser would hang or surprise. Gate
 * on a real TTY on both ends, honour `CI`/`INPLAN_NO_BROWSER`, and an explicit `--no-login`.
 */
export function canInteractiveLogin(args: string[]): boolean {
  if (hasFlag(args, "no-login")) return false;
  if (process.env.CI || process.env.INPLAN_NO_BROWSER) return false;
  // A human at a terminal has BOTH stdin and stdout as TTYs. Gate on stdout (not stderr): piping
  // stdout — `inplan wait --remote DOC | tool` — is programmatic use and must never open a browser,
  // yet stderr often stays a TTY there, so an stderr check would wrongly allow it.
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Ensure a cloud session exists before a foreground cloud command runs. When there are
 * no stored credentials:
 *  - a pending rendezvous a previous invocation started is RESUMED (blocks until the human
 *    finishes signing in — the second half of the coding-agent loop);
 *  - an interactive human gets the inline browser login (so the connect instruction is just
 *    `inplan wait --remote <doc>` — no separate `inplan login`);
 *  - a non-interactive caller (a coding agent, a pipe) gets a fresh session + the URL and
 *    resume command, and this process EXITS with EXIT_LOGIN_PENDING — agents only read our
 *    output once we exit, so blocking here would hide the URL until the login had already
 *    timed out. `--no-login` and CI keep the old contract: return false, caller errors.
 *
 * Scoped to the *missing credentials* case (loadAuth === null) on purpose: an expired
 * session still falls through to the existing refresh path + its message, so we never
 * pop a browser on every routine expiry. `login` is injectable for tests.
 */
export async function ensureLoggedIn(
  args: string[],
  login: () => Promise<AuthFile> = defaultRendezvousLogin,
  pendingExit: () => Promise<void> = pendingLoginExit,
  pollPending: (p: PendingLogin) => Promise<AuthFile> = (p) => pollLoginSession(p, { onNudge: printLoginNudge }),
): Promise<boolean> {
  if (loadAuth()) return true; // credentials present → remoteBackend refreshes (expiry handled there)

  // Explicit opt-outs FIRST — before resuming a sidecar or minting a session: both flags mean
  // "never wait on a human", and a stale login-pending.json (e.g. a cached CI home dir) must not
  // stall an unattended run for the whole poll window.
  if (loginOptOut(args)) return false;

  const pending = await loadPendingLogin();
  if (pending) {
    try {
      process.stderr.write(`inplan: waiting for the pending browser sign-in to finish…\n  ${pending.url}\n`);
      saveAuth(await pollPending(pending));
      await persistCloudIdentity();
      return true;
    } catch (e) {
      if (!(e instanceof LoginSessionExpiredError)) {
        // Foreground timeout / transport failure — the sidecar survives, the next run resumes.
        process.stderr.write(`inplan login: ${e instanceof Error ? e.message : String(e)}\n`);
        return false;
      }
      /* the session expired → fall through and start a fresh flow */
    }
  }

  if (canInteractiveLogin(args) && !isKnownAgentEnv()) {
    try {
      process.stderr.write("inplan: not signed in — opening your browser to sign in…\n");
      saveAuth(await login());
      await persistCloudIdentity();
      return true;
    } catch (e) {
      process.stderr.write(`inplan login: ${e instanceof Error ? e.message : String(e)}\n`);
      return false;
    }
  }

  await pendingExit();
  return false; // pendingLoginExit never returns in prod; injected test doubles do
}

/** The shared login opt-out — "never block on a human, never mint a session nobody will claim" —
 *  applied identically by BOTH entry points (`inplan login` and auto-login) before any path that
 *  resumes or creates a rendezvous session. */
function loginOptOut(args: string[]): boolean {
  return hasFlag(args, "no-login") || Boolean(process.env.CI);
}

/** The real browser handoff used by auto-login and `inplan login` (interactive-human path). */
function defaultRendezvousLogin(): Promise<AuthFile> {
  return rendezvousLogin({
    onUrl: (u) => process.stderr.write(`Opening your browser to sign in:\n  ${u}\nIf it didn't open, paste that URL into your browser.\n`),
    onNudge: printLoginNudge,
  });
}

/** The page never acked `opened` — the browser likely didn't launch (open() is fire-and-forget
 *  and a spawn "success" proves nothing); the human has to open the printed URL by hand. */
function printLoginNudge(): void {
  process.stderr.write("inplan: still waiting — the browser may not have opened. Open the sign-in URL above manually to continue.\n");
}

/**
 * Rung 2 of the login detection ladder (docs: cli-login-rendezvous plan): env markers that exist
 * ONLY inside a coding agent's tool shell, never in a human's terminal. Deliberately narrow —
 * e.g. Cursor sets CURSOR_* in its integrated terminal where a real human types, so it does NOT
 * belong here. A match routes login to the pending/exit path even on a PTY (some agent harnesses
 * allocate one for streaming); misdetection is safe either way because both paths converge on the
 * same resumable session.
 */
/** THE list of agent markers, so detection and scrubbing can never drift apart. Exact names, plus
 *  prefixes for families (Claude Code sets a whole CLAUDE_CODE_* family). */
export const AGENT_ENV_VARS = ["CLAUDECODE", "CODEX_SANDBOX", "PI_CODING_AGENT", "INPLAN_AGENT"] as const;
export const AGENT_ENV_PREFIXES = ["CLAUDE_CODE_"] as const;

export function isKnownAgentEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  // Claude Code: CLAUDECODE=1 + a CLAUDE_CODE_* family. Codex CLI: CODEX_SANDBOX for the sandboxed
  // run (Codex filters CODEX_* out of the inherited shell env, so it can't leak from a human's
  // config). Pi: PI_CODING_AGENT=true, set expressly for self-identification. INPLAN_AGENT: the
  // explicit opt-in for any other harness, never present in a human's terminal.
  return (
    AGENT_ENV_VARS.some((k) => Boolean(env[k])) || Object.keys(env).some((k) => AGENT_ENV_PREFIXES.some((p) => k.startsWith(p)))
  );
}

/**
 * A copy of `env` with every marker {@link isKnownAgentEnv} recognises removed.
 *
 * Tests that spawn the CLI and assert the NON-interactive path need this: a marker inherited from
 * whichever agent shell runs the suite routes the subprocess to the rendezvous pending-exit
 * instead. Sharing one list with the detector is the point — scrubbing a hand-written subset is
 * how the tests came to cover Claude's markers only, and would silently rot again the next time a
 * harness is added to the detector.
 */
export function scrubAgentEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if ((AGENT_ENV_VARS as readonly string[]).includes(k) || AGENT_ENV_PREFIXES.some((p) => k.startsWith(p))) delete out[k];
  }
  return out;
}

/**
 * Start a rendezvous session for a NON-interactive caller and exit. The printed block is written
 * FOR the coding agent reading it: the URL to relay, plus the exact command to re-run — which is
 * simply the command that just ran, because ensureLoggedIn resumes the pending sidecar. The JSON
 * line carries the same fields for parsers, and the distinct exit code lets wrappers branch.
 */
async function pendingLoginExit(): Promise<void> {
  let url: string;
  let expiresInSec: number;
  try {
    const pending = await createLoginSession();
    url = pending.url;
    expiresInSec = Math.max(0, Math.floor((pending.expiresAt - Date.now()) / 1000));
  } catch (e) {
    // Couldn't even mint a session (offline / server down) — fall back to the old guidance.
    process.stderr.write(`inplan login: ${e instanceof Error ? e.message : String(e)}\n`);
    return;
  }
  // Quote arguments that need it FOR THE ACTIVE SHELL: the skill tells the agent to re-run
  // `resume` VERBATIM, so an argument carrying a space or metacharacter must survive re-parsing
  // as ONE argument. POSIX single-quoting is wrong on Windows (cmd/PowerShell treat ' as data) —
  // there, wrap in double quotes with embedded quotes doubled, which both shells accept.
  const quoted = (a: string): string => {
    if (/^[A-Za-z0-9_@%+=:,.\/-]+$/.test(a)) return a;
    return process.platform === "win32" ? `"${a.replaceAll('"', '""')}"` : shellQuote(a);
  };
  // Credential-bearing flags must NOT round-trip through stdout/agent logs: a partial
  // `--refresh <token>` login that fell through to the browser path would otherwise serialize a
  // bearer credential into the printed resume line. The browser sign-in replaces them anyway.
  const argsSansCredentials: string[] = [];
  const skipValueOf = new Set(["--refresh", "--anon", "--url"]);
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (skipValueOf.has(a)) {
      // Drop the flag AND its value — but only when the next token IS a value. Options in this
      // CLI are `--`-prefixed (getFlag's boundary), so a token starting with a SINGLE hyphen is
      // a legitimate credential value (tokens can begin with '-') and must be dropped with its
      // flag; only another `--option` means the flag was valueless (empty $TOKEN expansion) and
      // that option must survive.
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) i++;
      continue;
    }
    if ([...skipValueOf].some((f) => a.startsWith(`${f}=`))) continue;
    argsSansCredentials.push(a);
  }
  // The executable half must also be re-runnable from THIS environment: a bare `inplan` only
  // exists for global installs. When the entry script was invoked under another name (npx cache,
  // a repo checkout's dist/cli.js), rebuild the invocation from the running node + entry script.
  const entry = process.argv[1] ?? "";
  const invokedAsInplan = entry.split(/[\\/]/).pop()?.replace(/\.(cmd|ps1)$/i, "") === "inplan";
  const argv0 = invokedAsInplan ? ["inplan"] : [quoted(process.execPath), quoted(entry)];
  const resume = [...argv0, ...argsSansCredentials.map(quoted)].join(" ");
  process.stderr.write(
    "inplan: sign-in required.\n" +
      `  ACTION (human): open this URL in a browser and sign in:\n    ${url}\n` +
      "  NEXT STEP (coding agent): show that URL to the human, then immediately RE-RUN the\n" +
      `  command you just ran (\`${resume}\`) — it waits for the sign-in to finish, then continues.\n` +
      `  The link expires in ${Math.max(1, Math.round(expiresInSec / 60))} minutes.\n`,
  );
  output({ status: "login_required", url, resume, expiresInSec });
  exitAfterFlush(EXIT_LOGIN_PENDING);
  // exitAfterFlush resolves asynchronously (stdout drain) — park forever so no caller code runs.
  await new Promise<never>(() => {});
}

/** Where the staleness check parks its verdict, so it costs one registry hit per TTL, not per turn. */
function stalenessCache(): { readCache: () => string | null; writeCache: (v: string) => void } {
  const path = join(sidecarRoot(), ".update-check.json");
  return {
    readCache: () => (existsSync(path) ? readFileSync(path, "utf8") : null),
    writeCache: (v) => {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, v);
    },
  };
}

/** `wait --remote` on a plan that doesn't include the local agent. Distinct from the generic 1 so a
 *  wrapper can tell "buy something" from "retry later" without scraping stderr. */
export const EXIT_UPGRADE_REQUIRED = 4;
/** `wait --remote` when we couldn't get a verified answer (offline / server error / bad bundle). */
export const EXIT_PLUGIN_UNAVAILABLE = 5;
/** A wait that gave up after repeated poll failures (usually an expired session). */
export const EXIT_WAIT_FAILED = 6;
/** Sign-in required but this caller is non-interactive: a rendezvous session was created and its
 *  URL printed (text + a `login_required` JSON line). Relay the URL to the human and RE-RUN the
 *  same command — it resumes the pending session and blocks until the sign-in completes. */
export const EXIT_LOGIN_PENDING = 7;

/**
 * Explain, to a human and to the coding agent reading our JSON, why we can't serve this cloud doc.
 *
 * The two reasons need different words: `unentitled` is a plan limit the human can act on, while
 * `unavailable` is a transient failure they should just retry. Telling a paying customer to upgrade
 * because a server hiccuped is the worst outcome here, which is why the reason is only ever
 * `unentitled` on an explicit server denial (see {@link resolvePluginOutcome}).
 */
/** POSIX single-quoting for a path we print inside a copy-pasteable command. An unquoted path with a
 *  space produces a command that silently targets the wrong file, and one containing `$(…)`, backticks
 *  or `;` would execute on paste. Single quotes suppress every expansion; the only character needing
 *  care is `'` itself, closed and re-opened around an escaped one. */
export function shellQuote(path: string): string {
  return "'" + path.replaceAll("'", "'\\''") + "'";
}

export function explainNoGate(reason: PluginAbsenceReason, localFile?: string): void {
  if (reason === "unentitled") {
    process.stderr.write(
      "inplan: this plan doesn't include the local agent on cloud documents.\n" +
        "  Open the document in your browser and click the agent indicator to upgrade.\n" +
        (localFile ? `  Or keep working offline for free: \`inplan demote ${shellQuote(localFile)}\` brings it back to disk.\n` : ""),
    );
    output({ status: "upgrade_required", reason, ...(localFile ? { localFile } : {}) });
    return;
  }
  process.stderr.write(
    "inplan: couldn't verify your plan for this cloud document (offline, or the service is down).\n" +
      "  This is not a plan limit — retry in a moment.\n" +
      (localFile ? `  To work offline meanwhile: \`inplan demote ${shellQuote(localFile)}\`.\n` : ""),
  );
  output({ status: "plugin_unavailable", reason, ...(localFile ? { localFile } : {}) });
}

/**
 * Drive a *cloud* document as the logged-in agent. There is no local editor to
 * spawn (a cloud doc opens in the browser), so `open`/`wait` both attach + wait
 * over the Supabase backend, and `signal` appends the agent's protocol events.
 *
 * `localFile` is set only when we reached the cloud by *following a promoted local
 * file's status* — it enables the Save-locally handoff (download the doc back to
 * its original path on disk). The bare `--remote <docId>` case has no local file.
 */
async function runRemote(cmd: string, docId: string, explicitCursor: number | null, confirmed: Set<string>, rest: string[], localFile?: string, model?: string): Promise<void> {
  // Self-heal a fresh machine: with no stored credentials, sign in inline (interactive
  // only) so `inplan wait --remote <doc>` works without a preceding `inplan login`.
  if (!(await ensureLoggedIn(rest))) {
    process.stderr.write("inplan: not logged in (or session expired) — run `inplan login`\n");
    process.exit(1);
  }
  const backend = await remoteBackend(docId, "cli-agent");
  if (!backend) {
    process.stderr.write("inplan: not logged in (or session expired) — run `inplan login`\n");
    process.exit(1);
  }


  if (cmd === "signal") {
    if (hasFlag(rest, "done")) {
      await backend.channel.append({ actor: "agent", type: LogEventType.AgentDoneSuggested });
    }
    if (hasFlag(rest, "reload")) {
      await backend.channel.append({ actor: "agent", type: LogEventType.ReloadSuggested });
    }
    output({ status: "signaled" });
    return;
  }

  // Relay a human-facing note to the cloud editor's status bar (informational; not a
  // wake signal). Mirrors the local `message` path so a cloud-promoted doc doesn't fall
  // through to waitCycle and block.
  if (cmd === "message") {
    // The text is the last positional arg — correct for both the promoted-local form
    // (`message <file> "text"`) and the remote form (`message --remote <id> "text"`),
    // where `rest` still carries `--remote` + the doc id. Strip flags and their values.
    const VALUE_FLAGS = new Set(["remote", "model", "cursor"]);
    const positional = rest.filter((a, i) => {
      if (a.startsWith("--")) return false; // the flag token itself
      const prev = rest[i - 1];
      return !(prev?.startsWith("--") && VALUE_FLAGS.has(prev.slice(2))); // a value-flag's value
    });
    const text = (positional[positional.length - 1] ?? "").trim();
    if (!text) {
      process.stderr.write('inplan message: usage: inplan message <file|--remote DOC_ID> "your message"\n');
      process.exit(1);
    }
    await backend.channel.append({ actor: "agent", type: LogEventType.AgentMessage, payload: { text } });
    output({ status: "messaged" });
    return;
  }

  // Cloud docs are the one place an out-of-date CLI fails *silently* — it attaches and looks fine
  // while missing the code path the document needs. Deliberately BELOW the `signal`/`message` early
  // returns: those run once per turn and must stay snappy, and a registry lookup only writes its
  // cache on success — so on a degraded network every short op would re-pay the full timeout. Only
  // the attaching path, which is the one that can silently misbehave, is worth the check.
  await warnIfOutdated(UPDATE_PKG, VERSION, stalenessCache());

  // A `wait` can block for longer than the ~1h access-token lifetime (the human idles before taking
  // their turn). Poll through a self-refreshing backend so the token is re-minted — via the
  // lock-coordinated authedSession() path, never an off-lock auto-refresh — before it expires,
  // instead of silently 401ing mid-wait. Short ops above (signal/message) used the one-shot `backend`.
  const live = liveRemoteBackend(docId, "cli-agent");

  // Live collaboration (paid perk): if the user is entitled, load the signature-verified collab
  // plugin and drive the agent's edits through the Yjs hub instead of a blind store overwrite. The
  // agent's working surface is a local `.md` materialized from the hub's canonical on first attach
  // (kept across turns so its edits survive); edits sync back via the gate.
  //
  // Resolved BEFORE announcing presence: an agent that is about to exit must never light up the
  // web's "agent · your machine" badge, and `process.exit` below would skip any `finally` teardown.
  const hubUrl = resolveHubUrl();
  const hubSession = JSON.stringify({ url: hubUrl, docName: docId, token: backend.token });
  const { gate, reason } = await loadPluginGateOutcome(hubSession, { token: backend.token });
  // No gate ⇒ STOP. The turn-based `live.store` path exists for the managed cloud agent, which holds
  // the body in memory; an out-of-process local agent needs a file, and the gate is what materializes
  // one. Falling through would attach, consume the human's turns, and silently never be able to read
  // or edit the document — so say why and exit non-zero instead.
  if (!gate) {
    explainNoGate(reason, localFile);
    exitAfterFlush(reason === "unentitled" ? EXIT_UPGRADE_REQUIRED : EXIT_PLUGIN_UNAVAILABLE);
    return;
  }

  // the web badge shows "agent · your machine"; clear it on exit.
  // (Presence is a cosmetic websocket on the initial token; the correctness-critical DB polling
  // rides `live` above and stays authenticated across the whole wait, even past the ~1h expiry.)
  const presence = announcePresence(docId, backend.token, model);
  try {
    const workFile = join(sidecarRoot(), "remote", `${docId}.plan.md`);
    const pendingPath = `${workFile}.pending`; // marker: a local fallback edit awaits a hub push
    const hashPath = `${workFile}.synced`; // hash of the working copy at our last write/sync
    mkdirSync(dirname(workFile), { recursive: true });
    const readIf = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
    const recordSynced = (content: string) => writeFileSync(hashPath, hashBody(content));

    // Probe the hub on EVERY run. A failure here means we cannot materialize the working copy, so
    // there is nothing for an out-of-process agent to read or edit — the same dead end the
    // missing-gate branch above rejects, reached one step later. Falling back to the turn-based
    // `live.store` path would just reinstate it silently, so stop and say so instead.
    let canonical = "";
    try {
      canonical = await gate.readCanonical();
    } catch (e) {
      process.stderr.write(`inplan: live-collab hub unreachable (${String(e)})\n`);
      explainNoGate("unavailable", localFile);
      exitAfterFlush(EXIT_PLUGIN_UNAVAILABLE);
      return; // the `finally` below tears presence down on the way out
    }
    // Decide whether to (re)hydrate the working copy from the freshly probed canonical. Seed if
    // absent; keep it if a local fallback edit is pending (must push first); otherwise refresh it
    // ONLY when the agent hasn't touched it since our last sync (hash match) — so we pull the
    // human's edits without clobbering unsynced agent edits. This is also what lets a FAILED
    // end-of-turn re-sync self-heal on the next run.
    const exists = existsSync(workFile);
    if (
      shouldHydrateWorkFile({
        exists,
        pending: existsSync(pendingPath),
        currentHash: exists ? hashBody(readFileSync(workFile, "utf8")) : null,
        syncedHash: readIf(hashPath),
      })
    ) {
      writeFileSync(workFile, canonical);
      recordSynced(canonical);
    }

    // Working doc stays on the local file, but Review-mode PROPOSALS persist to the CLOUD doc's
    // proposal store (via live.store) — otherwise a parked proposal would sit in this machine's
    // sidecar, invisible to the human in the web editor who's meant to accept/reject it.
    const localStore = fsBackend(workFile).store;
    const gateStore: DocumentStore = {
      loadDoc: () => localStore.loadDoc(),
      saveDoc: (c) => localStore.saveDoc(c),
      getCanonical: () => localStore.getCanonical(),
      setCanonical: (c) => localStore.setCanonical(c),
      backup: (c, m) => localStore.backup(c, m),
      getProposed: () => live.store.getProposed(),
      setProposed: (c) => live.store.setProposed(c),
      clearProposed: () => live.store.clearProposed(),
    };
    // Save-local handoff on the gate path reads the HUB canonical (the source of truth here);
    // live.store isn't updated by gate.applyRevision, so reading it would write a stale doc. If
    // the hub read fails we throw BEFORE writing status, so the doc isn't switched to local.
    const onSaveLocallyGate = localFile
      ? async () => {
          const body = await gate.readCanonical();
          writeFileSync(localFile, body);
          writeStatus(docPaths(localFile).statusPath, { location: "local", originalPath: localFile, lastSyncedHash: hashBody(body) });
          const pid = spawnApp(localFile);
          output({ status: "moved_local", path: localFile, reopened: pid !== null });
        }
      : undefined;

    // Guard BOTH hub directions so any drop degrades gracefully instead of crashing the turn,
    // tracking read and write failures separately (see trackGateDegradations): a read failure
    // re-throws (waitCycle falls back to the local store); a write failure persists the edit
    // locally and doesn't re-throw (the turn still emits a status). Any failure skips the
    // end-of-turn re-sync; only a WRITE marks `.pending` — a read-only failure must not, or the
    // next healthy run would skip hydration and risk reverting newer hub edits.
    const tracked = trackGateDegradations(gate, localStore, (m) =>
      process.stderr.write(`inplan: live-collab hub write failed (${m}); kept the edit locally to retry\n`),
    );
    process.stderr.write(`inplan: live-collab — plan at ${workFile}; read/edit it there, then re-run to sync\n`);
    const outcome = await waitCycle(
      {
        channel: live.channel, // turns/comments still ride the cloud control log (self-refreshing)…
        store: gateStore, // …the agent reads/edits a local working copy; proposals go to the cloud…
        history: async () => (await live.channel.readSince(0)).entries,
        logExit: () => {},
        ...(onSaveLocallyGate ? { onSaveLocally: onSaveLocallyGate } : {}),
      },
      explicitCursor,
      confirmed,
      model,
      tracked.gate, // …and accepted edits apply through the hub, not the store.
    );

    const action = postTurnAction(outcome, { readFailed: tracked.readFailed(), writeFailed: tracked.writeFailed() });
    if (action === "stop") return; // a fail-fast exit is pending — never touch the working copy

    if (action === "keep-local") {
      // The hub dropped mid-turn; DO NOT re-sync (that would overwrite a local edit with stale hub
      // canonical). Mark `.pending` ONLY when a WRITE failed — that's the case with a local
      // revision persisted off-hub that must be replayed. A read-only failure leaves the working
      // copy either unchanged (clean) or hash-diverged (agent edited); both are handled by the
      // start-of-turn hydration check, and a spurious `.pending` would wrongly skip it next run.
      if (pendingRequiresReplay({ readFailed: tracked.readFailed(), writeFailed: tracked.writeFailed() })) {
        writeFileSync(pendingPath, "1");
      }
      process.stderr.write("inplan: hub was unavailable this turn — keeping local edits (will sync next turn)\n");
    } else {
      // Turn applied to the hub. The working copy is now consistent with the hub for the agent's
      // part, so record its hash (this makes a FAILED re-sync below self-heal: next run sees a
      // matching hash and safely hydrates). Then re-sync the copy to the latest canonical (folding
      // in the human's just-taken turn) so the agent's NEXT turn builds on it, and clear pending.
      if (existsSync(pendingPath)) rmSync(pendingPath);
      recordSynced(readFileSync(workFile, "utf8"));
      try {
        const fresh = await gate.readCanonical();
        writeFileSync(workFile, fresh);
        recordSynced(fresh);
      } catch {
        /* transient: leave the copy (its hash still matches) so the next run hydrates it */
      }
    }
    return;
  } finally {
    presence.destroy();
  }
}

/** Print where a document currently lives (local vs cloud) and its cloud pointer. */
function doStatus(file: string): void {
  output(readStatus(docPaths(file).statusPath));
}

/**
 * Record that a local file is now collaborated on in the cloud — the status side
 * of "Collaborate on Cloud". (The upload + seed of the `documents` row is the
 * editor's job at promote time; this writes the local pointer so the running
 * `wait` and future `open`/`wait` calls follow the doc to the cloud.)
 */
function doPromote(file: string, args: string[]): void {
  const cloudDocId = getFlag(args, "cloud-doc");
  if (!cloudDocId) {
    process.stderr.write("usage: inplan promote <file> --cloud-doc <docId> [--locator org/repo/path]\n");
    process.exit(64);
  }
  const body = existsSync(file) ? readFileSync(file, "utf8") : "";
  const status: DocStatus = { location: "cloud", cloudDocId, originalPath: file, lastSyncedHash: hashBody(body) };
  const locator = getFlag(args, "locator");
  if (locator) {
    const [org, repo, ...rest] = locator.split("/");
    if (org && repo && rest.length) status.cloudLocator = { org, repo, path: rest.join("/") };
  }
  writeStatus(docPaths(file).statusPath, status);
  output({ status: "promoted", location: "cloud", cloudDocId });
}

/**
 * Bring a cloud doc back to disk — the CLI side of "Save locally" / "Download":
 * download the live body to its original path and flip the status to local, so
 * subsequent `open`/`wait` runs the file locally again.
 *
 * Reads the HUB canonical whenever a gate is available, exactly as `onSaveLocallyGate` does and for
 * the same reason: `live.store` is NOT updated by `gate.applyRevision`, so on a doc a local agent has
 * been editing through the hub it holds a stale body. Demoting from it would overwrite the original
 * file with pre-hub content — silently losing every edit made since, which is the one thing a
 * "bring it back to disk" command must never do. No gate (free plan, or the hub is down) ⇒ the store
 * is the best source there is, and the caller is told what it got.
 */
async function doDemote(file: string, args: string[]): Promise<void> {
  const p = docPaths(file);
  const st = readStatus(p.statusPath);
  if (st.location !== "cloud" || !st.cloudDocId) {
    process.stderr.write("inplan demote: document is not in the cloud\n");
    process.exit(1);
  }
  const backend = await remoteBackend(st.cloudDocId, "cli-agent");
  if (!backend) {
    process.stderr.write("inplan: not logged in (or session expired) — run `inplan login`\n");
    process.exit(1);
  }
  const hubSession = JSON.stringify({ url: resolveHubUrl(), docName: st.cloudDocId, token: backend.token });
  const { gate } = await loadPluginGateOutcome(hubSession, { token: backend.token });
  let hubBody: string | null = null;
  try {
    if (gate) hubBody = await gate.readCanonical();
  } catch {
    hubBody = null; // hub unreachable — we cannot verify what the store copy is missing
  }
  const dest = st.originalPath ?? file;
  const choice = demoteSource({ hubReadable: hubBody !== null, fromStore: hasFlag(args, "from-store") });
  if (choice.use === "abort") {
    process.stderr.write(
      "inplan demote: couldn't read the live document from the collab hub.\n" +
        `  The server copy may be missing edits made through the hub, and demoting overwrites ${shellQuote(dest)}\n` +
        "  and switches the document to local — together, that can't be undone.\n" +
        "  Retry when the hub is reachable, or re-run with --from-store to accept the server copy as-is.\n",
    );
    output({ status: "demote_blocked", reason: choice.reason, path: dest });
    exitAfterFlush(EXIT_PLUGIN_UNAVAILABLE);
    return;
  }
  const body = choice.use === "hub" ? hubBody! : await backend.store.loadDoc();
  writeFileSync(dest, body);
  writeStatus(p.statusPath, { location: "local", originalPath: dest, lastSyncedHash: hashBody(body) });
  output({ status: "demoted", location: "local", path: dest, source: choice.use });
}

/** First Markdown H1 in the body, for a cloud doc's title (falls back to the filename). */
function firstHeading(body: string): string | null {
  return body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || null;
}

/** Print the signed-in identity (the desktop app reads this for its profile menu). */
async function doWhoami(): Promise<void> {
  const user = await currentUser();
  if (!user) {
    output({ signedIn: false });
    return;
  }
  output({ signedIn: true, id: user.id, ...(user.email ? { email: user.email } : {}), ...(user.name ? { name: user.name } : {}) });
}

/** `inplan profile <file>` (resolve) | `inplan profile set --name N [--email E]`. */
async function doProfile(args: string[]): Promise<void> {
  if (args[0] === "set") {
    const name = getFlag(args, "name");
    if (!name || !name.trim()) {
      process.stderr.write('inplan profile set: usage: inplan profile set --name "Your Name" [--email you@example.com]\n');
      process.exit(64);
    }
    output(setManualProfile(name, getFlag(args, "email")));
    return;
  }
  // Otherwise resolve (and persist) the effective identity for the given doc.
  const file = args[0] && !args[0].startsWith("-") ? args[0] : undefined;
  output((await resolveIdentity(file)) ?? {});
}

/** Print a fresh access token for the signed-in session, for callers that talk to the
 *  cloud HTTP endpoints directly (the desktop app uses it to fetch entitlement-gated
 *  i18n catalogs). Refreshes via the stored session so the token is current. Prints an
 *  empty object when logged out — "no token" means not-signed-in, never an error. */
async function doToken(): Promise<void> {
  const s = await authedSession();
  output(s ? { token: s.session.access_token } : {});
}

/** The bundled `skill/SKILL.md` shipped in the published package (next to bin/), or null
 *  when running from source/dev (no sibling skill — auto-install is a published-package
 *  feature). `INPLAN_SKILL_SRC` overrides the path (used by tests so each spec points at its
 *  own SKILL.md instead of racing on the shared sibling `skill/` dir). */
function bundledSkillPath(): string | null {
  try {
    const override = process.env.INPLAN_SKILL_SRC;
    if (override) return existsSync(override) ? override : null;
    const p = join(dirname(fileURLToPath(import.meta.url)), "..", "skill", "SKILL.md");
    return existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

/** AI agents that use the same global skills convention as ours — a `skills/<name>/SKILL.md`
 *  under a per-user agent dir. `root` is the agent's home (we only install when it exists, so
 *  we never touch agents you don't have). Project-scoped agents (Cline `.clinerules`, Aider
 *  `CONVENTIONS.md`, Cursor `.cursor/rules`) read rules from the working repo, not a global
 *  dir — those are handled per-project, not by this global install. */
// --- Agent console relay (launch-independent hook target) ---------------------
//
// `install-skill` configures each present agent (Claude Code / Codex / Pi) to fire a
// hook on its own turn/tool events; the hook invokes `inplan relay`, which resolves the
// plan doc the agent is working on (the most-recently-active sidecar under the agent's
// CWD) and relays the note onto the SAME ControlChannel the agent already uses — so it
// surfaces in the editor's agent-message history whether the doc is local
// (FsControlChannel) or cloud-promoted (Supabase). Best-effort: it never errors the
// agent's turn (no active doc / not logged in / unparseable payload → silent no-op),
// and it rides the existing message channel — no new transport, no local socket.

/** The plan doc the agent is working on in `cwd`: the most-recently-active sidecar whose
 *  document path is at or under `cwd`. Null when none — so relay no-ops on ordinary,
 *  non-inplan turns. Works for local and cloud docs alike (both keep a sidecar with an
 *  `originalPath` + control log). */
export function activeDocForCwd(cwd: string): string | null {
  const root = sidecarRoot();
  if (!existsSync(root)) return null;
  // Compare *realpaths* so the under-CWD test survives symlinks (macOS /var → /private/var),
  // but return the doc's STORED path so docPaths() keys the same sidecar the editor uses.
  const real = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  const base = real(cwd);
  let best: { file: string; mtime: number } | null = null;
  for (const entry of readdirSync(root)) {
    try {
      const dir = join(root, entry);
      const orig = readStatus(join(dir, "status.json")).originalPath;
      if (!orig) continue;
      const rel = relative(base, real(orig));
      if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue; // not strictly under cwd
      const logPath = join(dir, "log.jsonl");
      const mtime = existsSync(logPath) ? statSync(logPath).mtimeMs : 0;
      if (!best || mtime > best.mtime) best = { file: resolve(orig), mtime };
    } catch {
      /* skip an unreadable sidecar */
    }
  }
  return best?.file ?? null;
}

/** Extract the note text from an agent hook payload, or null to no-op. Claude Code and
 *  Codex hooks both deliver one JSON object on stdin; Codex `notify` passes JSON as the
 *  last CLI argument. Tool events become a terse "▸ name" activity line. */
// Intra-turn flushing: a per-session cursor tracks how many assistant text blocks we've
// already relayed from the agent's transcript, so each tool-hook (which fires repeatedly
// DURING a turn) can flush the new prose the agent has written so far — sentences arrive as
// the agent works, not in one dump at turn end. Keyed by the agent's session id (or its
// transcript path), stored outside the per-doc sidecars.
function relayCursorPath(sessionKey: string): string {
  const id = createHash("sha1").update(sessionKey).digest("hex").slice(0, 16);
  return join(sidecarRoot(), ".relay-cursors", `${id}.json`);
}
function readRelayCursor(sessionKey: string): number {
  try {
    const v = JSON.parse(readFileSync(relayCursorPath(sessionKey), "utf8")) as { sent?: unknown };
    return typeof v.sent === "number" && v.sent >= 0 ? v.sent : 0;
  } catch {
    return 0;
  }
}
function writeRelayCursor(sessionKey: string, sent: number): void {
  try {
    const p = relayCursorPath(sessionKey);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ sent }) + "\n");
  } catch {
    /* cursor is an optimization; losing it only risks a re-send */
  }
}

/** Assistant text blocks (in order) from a Claude/Codex-style JSONL transcript — one per
 *  completed assistant text message. Defensive about shape; [] if unreadable/unknown. */
export function transcriptTextBlocks(path: string): string[] {
  const out: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return out;
  }
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const msg = (e.message ?? e) as Record<string, unknown>;
    const role = e.type ?? (msg as { role?: unknown }).role;
    if (role !== "assistant") continue;
    const content = (msg as { content?: unknown }).content;
    if (Array.isArray(content)) {
      for (const c of content) {
        const cc = c as { type?: unknown; text?: unknown };
        if (cc.type === "text" && typeof cc.text === "string" && cc.text.trim()) out.push(cc.text.trim());
      }
    } else if (typeof content === "string" && content.trim()) {
      out.push(content.trim());
    }
  }
  return out;
}

/** The notes to relay for one agent-hook firing: any NEW assistant prose since the session
 *  cursor (so it streams intra-turn at tool boundaries), then a "▸ tool" activity line for a
 *  tool event. Falls back to the payload's final message when no transcript is available
 *  (e.g. Codex `notify`). Advances the cursor as a side effect. */
export function notesFromHook(kind: string, stdin: string, argv: string[]): string[] {
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const parse = (s: string): Record<string, unknown> => {
    try {
      return s.trim() ? (JSON.parse(s.trim()) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  const notes: string[] = [];
  if (kind === "codex-notify") {
    // `notify` is per-turn (no transcript): just the final message.
    const last = str(parse(argv[argv.length - 1] ?? "")["last-assistant-message"]);
    if (last) notes.push(last);
    return notes;
  }
  const p = parse(stdin);
  const transcript = str(p.transcript_path);
  const sessionKey = str(p.session_id) || transcript;
  const blocks = transcript && existsSync(transcript) && sessionKey ? transcriptTextBlocks(transcript) : [];
  if (blocks.length > 0) {
    const sent = readRelayCursor(sessionKey);
    for (let i = Math.max(0, sent); i < blocks.length; i++) notes.push(blocks[i]!);
    if (blocks.length !== sent) writeRelayCursor(sessionKey, blocks.length); // advance only on a non-empty transcript
  } else {
    // No transcript, or a transcript whose shape we don't recognize (e.g. Codex) → don't drop
    // the prose: fall back to the payload's final assistant message. Cursor is left untouched.
    const last = str(p.last_assistant_message);
    if (last) notes.push(last);
  }
  if (kind === "claude-tool" || kind === "codex-tool") {
    const line = toolActivityText(p.tool_name, p.tool_input);
    if (line) notes.push(`▸ ${line}`); // activity line, after any prose the agent wrote first
  }
  return notes;
}

/** Append a human-facing agent note onto the doc's control channel, routed to wherever the
 *  doc lives (local fs or cloud). Best-effort; swallows all errors. */
async function relayText(file: string, text: string): Promise<void> {
  try {
    const route = routeFor(file, "message", []);
    if (route.kind === "cloud") {
      const backend = await remoteBackend(route.docId, "cli-agent");
      if (!backend) return; // not logged in → skip silently
      await backend.channel.append({ actor: "agent", type: LogEventType.AgentMessage, payload: { text } });
    } else if (route.kind === "local") {
      const p = docPaths(file);
      mkdirSync(p.controlDir, { recursive: true });
      await new FsControlChannel(p).append({ actor: "agent", type: LogEventType.AgentMessage, payload: { text } });
    }
    // reconcile → skip: a relay must never force a sync decision.
  } catch {
    /* relay is best-effort; never break the agent's turn */
  }
}

/** `inplan relay` — invoked by an agent hook (see install-skill). Resolves the active plan doc
 *  for the CWD and relays the agent's new prose + tool activity to its editor. Always exits 0
 *  (best-effort). Resolves the doc FIRST so a no-op never advances the transcript cursor. */
async function doRelay(args: string[]): Promise<void> {
  const file = activeDocForCwd(process.cwd());
  if (!file) {
    output({ status: "relay_skipped", reason: "no_active_doc" });
    return;
  }
  const hook = getFlag(args, "hook");
  let notes: string[];
  if (hook) {
    let stdin = "";
    // codex-notify carries its payload in argv, not stdin — skip the fd0 read (which could
    // block on a TTY with no piped input). All other hooks deliver JSON on stdin.
    if (hook !== "codex-notify") {
      try {
        stdin = readFileSync(0, "utf8");
      } catch {
        /* no stdin available */
      }
    }
    notes = notesFromHook(hook, stdin, process.argv);
  } else {
    const t = getFlag(args, "text");
    notes = t === undefined ? [] : [hasFlag(args, "activity") ? `▸ ${t}` : t];
  }
  const clean = notes.map((n) => n.trim().slice(0, 2000)).filter(Boolean); // cap each note
  if (clean.length === 0) {
    output({ status: "relay_skipped", reason: "no_text" });
    return;
  }
  for (const n of clean) await relayText(file, n);
  output({ status: "relayed", count: clean.length });
}

function skillTargets(): { name: string; root: string; target: string }[] {
  const home = homedir();
  return [
    { name: "Claude Code", root: join(home, ".claude"), target: join(home, ".claude", "skills", "inplan", "SKILL.md") },
    { name: "Pi", root: join(home, ".pi", "agent"), target: join(home, ".pi", "agent", "skills", "inplan", "SKILL.md") },
    { name: "Codex", root: join(home, ".codex"), target: join(home, ".codex", "skills", "inplan", "SKILL.md") },
  ];
}

/** Scoped auto-approval rules merged into Claude Code's user settings: the inplan CLI,
 *  editing plan files, and the ~/.inplan sidecars (control log / canonical / proposed /
 *  backups / status). The human reviews every change in the inplan app, so these never
 *  need a per-edit prompt. Deliberately narrow — NOT a global permission bypass. */
// NB: no `Write(...)` rules — an `Edit(<path>)` rule already covers ALL file-editing tools (Write
// included), and Claude Code's permission system ignores `Write(<path>)` rules and warns about them.
const SKILL_ALLOW = ["Bash(inplan *)", "Edit(**/*.plan.md)", "Read(~/.inplan/**)", "Edit(~/.inplan/**)"];
// Rules earlier versions added that are now inert + warned-about — pruned on merge (below) so an
// existing install stops surfacing the warning. Only ever the exact rules we added, never a user's.
const SKILL_ALLOW_OBSOLETE = ["Write(**/*.plan.md)", "Write(~/.inplan/**)"];
const SKILL_DIRS = ["~/.inplan/"]; // sidecars live outside the project cwd; grant file access there

/** Merge {@link SKILL_ALLOW} / {@link SKILL_DIRS} into `~/.claude/settings.json`, preserving
 *  everything else and de-duplicating. Returns whether it changed anything. Never throws and
 *  never clobbers an unparseable / non-object settings file. */
function grantClaudePermissions(claudeRoot: string): boolean {
  const settingsPath = join(claudeRoot, "settings.json");
  let settings: Record<string, unknown> = {};
  try {
    if (existsSync(settingsPath)) {
      const parsed = JSON.parse(readFileSync(settingsPath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false; // don't clobber
      settings = parsed as Record<string, unknown>;
    }
  } catch {
    return false; // unparseable — leave the user's settings untouched
  }
  // A plain object only — an array (or null) for `permissions` would silently drop our
  // allow/additionalDirectories keys on JSON.stringify (and falsely report a grant).
  const rawPerms = settings.permissions;
  const perms = (rawPerms && typeof rawPerms === "object" && !Array.isArray(rawPerms) ? rawPerms : {}) as Record<string, unknown>;
  let allow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
  const dirs = Array.isArray(perms.additionalDirectories) ? (perms.additionalDirectories as string[]) : [];
  let changed = false;
  // Prune the now-obsolete Write(...) rules a prior install added (Edit already covers Write, and
  // these trip a Claude Code warning). Only these exact strings — never a user's own Write rules.
  const beforePrune = allow.length;
  allow = allow.filter((r) => !SKILL_ALLOW_OBSOLETE.includes(r));
  if (allow.length !== beforePrune) changed = true;
  for (const r of SKILL_ALLOW) {
    if (!allow.includes(r)) {
      allow.push(r);
      changed = true;
    }
  }
  for (const d of SKILL_DIRS) {
    if (!dirs.includes(d)) {
      dirs.push(d);
      changed = true;
    }
  }
  if (!changed) return false;
  perms.allow = allow;
  perms.additionalDirectories = dirs;
  settings.permissions = perms;
  // Atomic: write a sibling temp file then rename over the target, so a crash mid-write
  // can never leave a truncated/corrupt settings.json. Honors the "never throws" contract.
  try {
    const tmp = settingsPath + ".tmp";
    writeFileSync(tmp, JSON.stringify(settings, null, 2) + "\n");
    renameSync(tmp, settingsPath);
  } catch {
    return false;
  }
  return true;
}

// Agent-console relay hooks per agent: event → the `inplan relay --hook` command the
// agent runtime fires. Claude Code + Codex share the Claude-style hooks schema
// (`<settings>.hooks.<Event>`). Installed by `install-skill` (extends the #49 scoped grant).
const CLAUDE_RELAY_HOOKS = [
  { event: "Stop", command: "inplan relay --hook claude-stop" },
  { event: "PostToolUse", command: "inplan relay --hook claude-tool" },
];
const CODEX_RELAY_HOOKS = [
  { event: "Stop", command: "inplan relay --hook codex-stop" },
  { event: "PostToolUse", command: "inplan relay --hook codex-tool" },
];

/** Merge command-hooks into a Claude/Codex-style hooks object (`obj.hooks.<Event>` = array
 *  of groups, each `{ hooks: [{ type:"command", command }] }`). Idempotent — skips a command
 *  already present under its event. Returns whether it changed anything. */
function mergeRelayHooks(settings: Record<string, unknown>, entries: { event: string; command: string }[]): boolean {
  const raw = settings.hooks;
  const hooks = (raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  let changed = false;
  for (const { event, command } of entries) {
    const existing = hooks[event];
    // Coerce to the array shape WITHOUT clobbering a user's config: an array is used as-is;
    // a single hook-group object is wrapped; any other non-array (string / unknown shape) is
    // left untouched and skipped (we'd rather not install our hook than overwrite it).
    let arr: Array<Record<string, unknown>>;
    if (Array.isArray(existing)) {
      arr = existing as Array<Record<string, unknown>>;
    } else if (existing === undefined) {
      arr = [];
    } else if (existing && typeof existing === "object" && Array.isArray((existing as { hooks?: unknown }).hooks)) {
      arr = [existing as Record<string, unknown>]; // a lone group object → wrap into an array
    } else {
      continue; // unknown non-array shape → don't touch it
    }
    const present = arr.some((g) => {
      const hs = (g as { hooks?: unknown }).hooks;
      return Array.isArray(hs) && hs.some((h) => (h as { command?: unknown })?.command === command);
    });
    if (!present) {
      arr.push({ hooks: [{ type: "command", command }] });
      changed = true;
    }
    hooks[event] = arr;
  }
  if (changed) settings.hooks = hooks;
  return changed;
}

/** Read a JSON config file into a plain object; `null` if it exists but isn't a JSON object
 *  (so we never clobber a file we don't understand). A missing file reads as `{}`. */
function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Atomic JSON write (sibling temp + rename). Returns false on any IO error. */
function writeJsonAtomic(path: string, value: unknown): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/** Install the agent-console relay hooks into Claude Code's settings.json (alongside the
 *  scoped permissions already written there). Idempotent, atomic, never clobbers. */
function installClaudeHooks(claudeRoot: string): boolean {
  const path = join(claudeRoot, "settings.json");
  const settings = readJsonObject(path);
  if (!settings || !mergeRelayHooks(settings, CLAUDE_RELAY_HOOKS)) return false;
  return writeJsonAtomic(path, settings);
}

/** Install the relay hooks into Codex's hooks.json (same schema, JSON form — avoids TOML).
 *  Idempotent, atomic, never clobbers. */
function installCodexHooks(codexRoot: string): boolean {
  const path = join(codexRoot, "hooks.json");
  const cfg = readJsonObject(path);
  if (!cfg || !mergeRelayHooks(cfg, CODEX_RELAY_HOOKS)) return false;
  return writeJsonAtomic(path, cfg);
}

// The Pi auto-loaded extension that relays turn messages + tool activity to `inplan relay`.
// The marker lets the installer re-write it on upgrade without clobbering a user's own file.
const PI_RELAY_MARKER = "// inplan-relay (managed by `inplan install-skill`)";
const PI_RELAY_EXTENSION = `${PI_RELAY_MARKER}
// Auto-loaded on every \`pi\` run from ~/.pi/agent/extensions/. Forwards the agent's per-turn
// message + per-tool activity to the inplan editor via \`inplan relay\` (which routes to the
// local or cloud doc). Fire-and-forget so it never stalls the agent.
import { spawn } from "node:child_process";

function relay(args) {
  try {
    const child = spawn("inplan", ["relay", ...args], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    /* best-effort */
  }
}

function assistantText(message) {
  if (!message || message.role !== "assistant") return "";
  if (Array.isArray(message.content)) {
    return message.content.filter((c) => c && c.type === "text").map((c) => c.text).join(" ").trim();
  }
  return typeof message.content === "string" ? message.content.trim() : "";
}

export default function (pi) {
  // message_end fires per COMPLETED assistant message — so prose streams during the turn,
  // not in one dump at agent_end.
  pi.on("message_end", (event) => {
    const text = assistantText(event && event.message);
    if (text) relay(["--text", text]);
  });
  pi.on("tool_execution_start", (event) => {
    if (!event || !event.toolName) return;
    // Best-effort detail when Pi exposes the tool input on the event (field name varies):
    // Bash → first 30 chars of the command; file tools → the file (tail). Else the tool name.
    const a = event.args || event.toolInput || event.input || {};
    const clip = (s, head) => (s.length > 30 ? (head ? s.slice(0, 30) + "…" : "…" + s.slice(s.length - 30)) : s);
    let detail = "";
    if (event.toolName === "Bash" && typeof a.command === "string") detail = clip(a.command.replace(/\\s+/g, " ").trim(), true);
    else { const f = a.file_path || a.notebook_path || a.path; if (typeof f === "string" && f.trim()) detail = clip(f.trim(), false); }
    relay(["--activity", "--text", detail ? String(event.toolName) + ": " + detail : String(event.toolName)]);
  });
}
`;

/** Drop the Pi relay extension into ~/.pi/agent/extensions/. Writes only when absent or when
 *  our own marker is present but stale (idempotent upgrades) — never clobbers a user file. */
function installPiRelayExtension(piAgentRoot: string): boolean {
  const path = join(piAgentRoot, "extensions", "inplan-relay.ts");
  try {
    if (existsSync(path)) {
      const cur = readFileSync(path, "utf8");
      if (cur === PI_RELAY_EXTENSION) return false; // already current
      if (!cur.startsWith(PI_RELAY_MARKER)) return false; // a user's own file — leave it
    }
    mkdirSync(dirname(path), { recursive: true });
    const tmp = path + ".tmp";
    writeFileSync(tmp, PI_RELAY_EXTENSION);
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Install the inplan skill into AI agents already present on this machine (the npm→skill
 * half of the bidirectional bootstrap; the skill→CLI half lives in SKILL.md's install
 * note). Guard-railed: opt-out via INPLAN_NO_SKILL_INSTALL, only touches agents that
 * already exist, never overwrites an existing skill (idempotent), and never throws — so
 * it's safe to run from `postinstall`. `--quiet` suppresses the JSON summary (postinstall).
 */
function doInstallSkill(args: string[]): void {
  const quiet = hasFlag(args, "quiet");
  if (process.env.INPLAN_NO_SKILL_INSTALL) {
    if (!quiet) output({ status: "skipped", reason: "INPLAN_NO_SKILL_INSTALL" });
    return;
  }
  const src = bundledSkillPath();
  if (!src) {
    if (!quiet) output({ status: "unavailable" }); // dev/source — nothing bundled to install
    return;
  }
  const installed: string[] = [];
  for (const a of skillTargets()) {
    try {
      if (!existsSync(a.root)) continue; // agent not installed → leave it alone
      if (!existsSync(a.target)) {
        mkdirSync(dirname(a.target), { recursive: true });
        copyFileSync(src, a.target);
        installed.push(a.name);
        process.stderr.write(`inplan: installed the inplan skill into ${a.name} (${a.target}). Set INPLAN_NO_SKILL_INSTALL=1 to skip.\n`);
      }
      // Claude Code: also grant scoped auto-approval so the agent doesn't prompt on plan-file
      // / sidecar edits + the inplan CLI (the human reviews every change in the app). Runs even
      // when the skill was already present, so existing installs pick up the grant.
      if (a.name === "Claude Code" && grantClaudePermissions(a.root)) {
        process.stderr.write(`inplan: granted scoped auto-approval (plan files + ~/.inplan + inplan CLI) in ${join(a.root, "settings.json")}.\n`);
      }
      // Agent-console relay: configure each agent's own hooks (launch-independent) to relay
      // the agent's turn message + tool activity to the editor. Runs even when the skill was
      // already present, so existing installs pick up the relay.
      if (a.name === "Claude Code" && installClaudeHooks(a.root)) {
        process.stderr.write(`inplan: configured the agent-console relay hooks in ${join(a.root, "settings.json")}.\n`);
      }
      if (a.name === "Codex" && installCodexHooks(a.root)) {
        process.stderr.write(`inplan: configured the agent-console relay hooks in ${join(a.root, "hooks.json")}.\n`);
      }
      if (a.name === "Pi" && installPiRelayExtension(a.root)) {
        process.stderr.write(`inplan: installed the agent-console relay extension in ${join(a.root, "extensions", "inplan-relay.ts")}.\n`);
      }
    } catch {
      /* never fail an install over a skill copy / settings merge */
    }
  }
  if (!quiet) output({ status: "ok", installed });
}

/** Forget stored credentials (sign out). */
function doLogout(): void {
  clearAuth();
  output({ status: "logged_out" });
}

/**
 * Collaborate on Cloud: create + seed a cloud `documents` row from a local file in
 * one of the user's writable orgs, then promote the local file's status to point
 * at it. After this, the running `wait` (and future `open`/`wait`) follow the doc
 * into the cloud (slice 2b). The editor's "Collaborate on Cloud" menu item shells
 * out to this.
 */
export async function doUpload(file: string, args: string[]): Promise<void> {
  const s = await authedSession();
  if (!s) {
    process.stderr.write("inplan: not logged in (or session expired) — run `inplan login`\n");
    process.exit(1);
  }
  const orgSlug = getFlag(args, "org");
  const { data: mems, error } = await s.db.from("memberships").select("org_id, role, orgs(slug, name)").in("role", ["owner", "editor"]);
  if (error) {
    process.stderr.write(`inplan upload: ${error.message}\n`);
    process.exit(1);
  }
  type Row = { org_id: string; orgs: { slug: string | null; name: string } | { slug: string | null; name: string }[] | null };
  const rows = (mems ?? []) as Row[];
  const orgOf = (r: Row) => (Array.isArray(r.orgs) ? r.orgs[0] : r.orgs) ?? null;
  const pick = rows.find((r) => (orgSlug ? orgOf(r)?.slug === orgSlug : true));
  if (!pick) {
    process.stderr.write(`inplan upload: no organization you can write to${orgSlug ? ` matching "${orgSlug}"` : ""}\n`);
    process.exit(1);
  }
  const org = orgOf(pick);

  const body = existsSync(file) ? readFileSync(file, "utf8") : "";
  // Provenance: stamp the doc with its git repo + repo-relative path so the cloud
  // locator mirrors the source (relative MD links then resolve the same on the web).
  const prov = gitProvenance(file);
  const repo = getFlag(args, "repo") ?? prov.repo;
  const path = getFlag(args, "path") ?? prov.path;
  const title = firstHeading(body) ?? basename(path);

  // Create through the shared create_document RPC (the single source of truth for the active-doc
  // cap + LRU eviction) so `inplan upload` behaves identically to the web plan-list and the editor
  // Create/Move. Without --evict-lru it is a SIDE-EFFECT-FREE probe: at the cap it returns
  // {status:'limit', ...} and writes nothing, so the desktop can confirm before deactivating the
  // LRU. With --evict-lru the confirmed call deactivates the LRU then inserts. The RPC stamps the
  // owner (auth.uid()) so the uploader owns the doc (M4.8 doc scope).
  const { data: res, error: de } = await s.db.rpc("create_document", {
    p_org: pick.org_id,
    p_repo: repo,
    p_path: path,
    p_title: title,
    p_body: body,
    p_draft_pending: false,
    p_evict_lru: hasFlag(args, "evict-lru"),
  });
  const out0 = res as { status?: string; id?: string; limit?: number; lru_id?: string; lru_title?: string } | null;
  if (de || !out0) {
    process.stderr.write(`inplan upload: ${de?.message ?? "could not create the cloud document"}\n`);
    process.exit(1);
  }
  // At the cap (and not confirmed): emit the limit + the LRU and stop — NOTHING was created or
  // deactivated. The desktop parses this to confirm, then re-runs `upload <file> --evict-lru`.
  if (out0.status === "limit") {
    output({ status: "limit", limit: out0.limit ?? 0, lru: { id: out0.lru_id ?? "", title: out0.lru_title ?? "" } });
    return;
  }
  // The doc already exists at this locator (a re-upload): adopt the existing row so the upload is
  // idempotent — point the local status at it instead of failing.
  let cloudDocId: string;
  if (out0.status === "exists") {
    const { data: ex } = await s.db.from("documents").select("id").eq("org_id", pick.org_id).eq("repo", repo).eq("path", path).maybeSingle();
    const exId = (ex as { id?: string } | null)?.id;
    if (!exId) {
      process.stderr.write("inplan upload: a document already exists at this path but could not be resolved\n");
      process.exit(1);
    }
    cloudDocId = exId;
  } else if (out0.status === "created" && out0.id) {
    cloudDocId = out0.id;
  } else {
    process.stderr.write("inplan upload: could not create the cloud document\n");
    process.exit(1);
  }

  // Migrate any pre-existing local images (pasted while the doc was still local, so they're
  // relative links into a sibling `.assets/` folder) into the cloud bucket, and rewrite the body's
  // links to the resulting public URLs — otherwise the doc arrives in the cloud with links into a
  // folder that has no counterpart there. Applied to the file on disk too so the local copy's hash
  // matches what's now stored in the cloud (status.lastSyncedHash below), keeping the next
  // local⇄cloud reconcile check honest. Best-effort: a migration failure must not fail the promote
  // itself — the doc is already created; the human can always fall back to re-pasting the images
  // once collaborating in the cloud.
  //
  // Only for a brand-new row (out0.status === "created"): under the unified-Yjs model the collab
  // hub is the SOLE writer of `documents.body` (materialized from the live CRDT) once a doc has
  // ever been touched there. A freshly-created row has no hub session yet, so writing its body
  // here is safe; re-running `upload` against an EXISTING doc (out0.status === "exists") must
  // never do this write — it would race the hub and can silently clobber edits made in the cloud
  // that this local file hasn't pulled (flagged in review: cubic-dev-ai + melly-lgtm on PR #91).
  let finalBody = body;
  if (out0.status === "created") {
    try {
      const migrated = await migrateLocalImages(body, dirname(file), s.db, pick.org_id, cloudDocId);
      if (migrated.migrated > 0) {
        // Cloud first, then local, then only NOW does `finalBody` (and so lastSyncedHash below)
        // reflect the migrated body. If saveDoc throws, we never reach the local write or the
        // reassignment — the local file and finalBody both stay at the ORIGINAL body, so the
        // persisted hash always matches whatever the local file actually contains. The old
        // local-first order could leave lastSyncedHash claiming sync (hash of the migrated body)
        // while the cloud still held the pre-migration one, on nothing more than a failed cloud
        // write (flagged in review: cubic-dev-ai + melly-lgtm on PR #91).
        await new SupabaseDocumentStore(s.db, cloudDocId).saveDoc(migrated.body);
        writeFileSync(file, migrated.body);
        finalBody = migrated.body;
      }
    } catch (e) {
      process.stderr.write(`inplan upload: image migration failed (${e instanceof Error ? e.message : String(e)}) — the doc uploaded, but its local images weren't moved to the cloud\n`);
    }
  }

  const status: DocStatus = {
    location: "cloud",
    cloudDocId,
    originalPath: file,
    lastSyncedHash: hashBody(finalBody),
    ...(org?.slug ? { cloudLocator: { org: org.slug, repo, path } } : {}),
  };
  writeStatus(docPaths(file).statusPath, status);
  output({ status: "uploaded", cloudDocId, ...(org?.slug ? { locator: { org: org.slug, repo, path } } : {}) });
}

/** Extensions this uploader accepts, mapped to their Storage `Content-Type` — mirrors the cloud
 *  web app's ASSET_MIME_BY_EXT and the `doc-images` bucket's allowed_mime_types (inplan-cloud's
 *  `20260804000000_doc_images_bucket.sql`). Anything else falls back to png, same as the local
 *  `asset:save` write path. */
const ASSET_MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
};
const ASSET_BUCKET = "doc-images";

/** Upload one image's bytes to the `doc-images` bucket at `orgId/docId/image-<stamp>[-n].<ext>`,
 *  disambiguating on a name collision (409) — shared by `doAssetUpload` (a single live paste) and
 *  {@link migrateLocalImages} (a promote-time batch). Returns the public URL, or null on a real
 *  (non-collision) failure. */
async function uploadAssetBytes(db: SupabaseClient, orgId: string, docId: string, bytes: Buffer, ext: string): Promise<string | null> {
  // hasOwnProperty, not a truthy lookup — see the identical guard in the cloud web app's
  // saveAsset (ASSET_MIME_BY_EXT[ext] is truthy for inherited Object.prototype names too).
  const safeExt = Object.prototype.hasOwnProperty.call(ASSET_MIME_BY_EXT, ext) ? ext : "png";
  const contentType = ASSET_MIME_BY_EXT[safeExt]!;
  const stamp = new Date().toISOString().replace(/[^0-9]/g, "").slice(0, 14); // YYYYMMDDHHMMSS
  for (let n = 0; n <= 5; n++) {
    const name = n === 0 ? `image-${stamp}.${safeExt}` : `image-${stamp}-${n}.${safeExt}`;
    const path = `${orgId}/${docId}/${name}`;
    const { error } = await db.storage.from(ASSET_BUCKET).upload(path, bytes, { contentType });
    if (!error) return db.storage.from(ASSET_BUCKET).getPublicUrl(path).data.publicUrl;
    if (error.status !== 409) return null; // not a name collision — a real failure, don't retry
  }
  return null; // exhausted collision retries
}

/**
 * Upload a pasted/picked image straight to the cloud `doc-images` bucket instead of writing it
 * next to the local file — the desktop app calls this when it's live-connected to a cloud doc
 * (Collaborate on Cloud), so a locally pasted image never needs a later migration. `--bytes-file`
 * points at a temp file the caller (Electron main) wrote the raw bytes to; this command only
 * reads it — the caller owns its lifecycle (creation + cleanup).
 */
export async function doAssetUpload(file: string, args: string[]): Promise<void> {
  const status = readStatus(docPaths(file).statusPath);
  if (status.location !== "cloud" || !status.cloudDocId) {
    process.stderr.write("inplan asset-upload: document is not in the cloud\n");
    process.exit(1);
  }
  const bytesFile = getFlag(args, "bytes-file");
  if (!bytesFile) {
    process.stderr.write("inplan asset-upload: usage: inplan asset-upload <file> --bytes-file <path> [--ext <ext>]\n");
    process.exit(64);
  }
  const s = await authedSession();
  if (!s) {
    process.stderr.write("inplan: not logged in (or session expired) — run `inplan login`\n");
    process.exit(1);
  }
  // The bucket's insert policy checks the path's org segment against `documents.org_id` itself
  // (20260804000000_doc_images_bucket.sql), so this lookup doubles as the ownership check — an
  // upload for a doc this session can't write to fails the RLS check with the wrong org anyway.
  const { data: doc, error: docErr } = await s.db.from("documents").select("org_id").eq("id", status.cloudDocId).maybeSingle();
  const orgId = (doc as { org_id?: string } | null)?.org_id;
  if (docErr || !orgId) {
    process.stderr.write(`inplan asset-upload: ${docErr?.message ?? "could not resolve the document's organization"}\n`);
    process.exit(1);
  }
  const requestedExt = (getFlag(args, "ext") ?? "png").toLowerCase();
  const bytes = readFileSync(bytesFile);
  const relPath = await uploadAssetBytes(s.db, orgId, status.cloudDocId, bytes, requestedExt);
  if (!relPath) {
    process.stderr.write("inplan asset-upload: upload failed\n");
    process.exit(1);
  }
  output({ status: "uploaded", relPath });
}

/** A Markdown image reference: `![alt](<dest>)` (the angle-bracket form the editor writes for
 *  asset:save — needed because `<docname>.assets/…` can contain spaces) or the bare `![alt](dest)`
 *  form (no unescaped whitespace/parens, which the bracket-less destination syntax can't carry). */
const IMAGE_REF_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^()\s]+))\s*\)/g;

/** True for a relative path (not a URL) — mirrors the renderer's image-src resolver
 *  (`markdown.ts`) so promote-time migration and live rendering agree on what counts as "local". */
function isLocalRelativePath(dest: string): boolean {
  return !/^[a-z][a-z0-9+.-]*:/i.test(dest) && !dest.startsWith("//") && !dest.startsWith("/");
}

/**
 * Scan `body` for local relative image links, upload each referenced file (resolved against
 * `docDir`) to the cloud `doc-images` bucket, and rewrite the links to the resulting public URLs.
 * Run at promote time (`inplan upload`) so a doc pasted into while still local doesn't arrive in
 * the cloud with links into a `.assets/` folder that has no counterpart there — otherwise the CLI
 * command genuinely would be pointless, since nothing would ever call it for the images that
 * matter most (the ones already in the doc when it's promoted). Best-effort per image: a missing
 * file or a failed upload just leaves that one link untouched rather than losing the reference.
 */
async function migrateLocalImages(body: string, docDir: string, db: SupabaseClient, orgId: string, docId: string): Promise<{ body: string; migrated: number }> {
  const replacements = new Map<string, string>(); // matched destination → new public URL
  // A doc body isn't trusted-solely-authored input (cloned repos, collaborators, agents write
  // it), so a crafted `../../.ssh/id_ed25519`-style link must not let this read a file outside
  // the doc's own directory and publish it to the (public) bucket. Resolve symlinks on the root
  // once, up front — a missing docDir (shouldn't happen; the doc file itself was just read) means
  // nothing here can be verified as contained, so no image gets migrated rather than trusting an
  // unresolved path.
  let docDirReal: string;
  try {
    docDirReal = realpathSync(docDir);
  } catch {
    return { body, migrated: 0 };
  }
  for (const m of body.matchAll(IMAGE_REF_RE)) {
    const dest = m[2] ?? m[3] ?? "";
    if (!dest || !isLocalRelativePath(dest) || replacements.has(dest)) continue;
    const abs = resolve(docDir, dest);
    if (!existsSync(abs)) continue; // already dangling — nothing to migrate
    // Containment: resolve symlinks on this side too, so a symlink that LOOKS like it's inside
    // docDir can't point at a file outside it.
    let absReal: string;
    try {
      absReal = realpathSync(abs);
    } catch {
      continue;
    }
    const rel = relative(docDirReal, absReal);
    if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) continue;
    // Only a recognized image extension — never fall back to png here. Unlike the live-paste path
    // (doAssetUpload), where the bytes are known to be an image the user just picked, this reads
    // an arbitrary file off disk; an unrecognized extension is a reason to skip it, not to guess
    // and publish it as one anyway.
    const ext = extname(abs).slice(1).toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ASSET_MIME_BY_EXT, ext)) continue;
    let bytes: Buffer;
    try {
      bytes = readFileSync(abs);
    } catch {
      continue;
    }
    const url = await uploadAssetBytes(db, orgId, docId, bytes, ext);
    if (url) replacements.set(dest, url);
  }
  if (replacements.size === 0) return { body, migrated: 0 };
  // Rebuild from the captured groups rather than doing regex surgery on `whole`: alt text can
  // itself contain parens (`![a (x) b](img.png)`), and a second "find the first (...)" pass over
  // the whole match would rewrite the URL into the alt text's parens instead of the destination,
  // corrupting the link and leaving the real destination still pointing at the local file.
  const newBody = body.replace(IMAGE_REF_RE, (whole, alt: string, bracketed?: string, bare?: string) => {
    const url = replacements.get(bracketed ?? bare ?? "");
    return url ? `![${alt}](${url})` : whole;
  });
  return { body: newBody, migrated: replacements.size };
}

/** `comment` (see ./commentAdd.ts) only knows how to rewrite a local file — reject it before
 *  either cloud path (`--remote DOC_ID`, or a promoted local doc that `routeFor` sends to the
 *  Supabase backend) reaches `runRemote`, which has no "comment" case and would otherwise fall
 *  through into `waitCycle` and silently do the wrong thing. `hasLocalFile` distinguishes the
 *  two: a promoted doc genuinely has a local file to hand-edit as a fallback; a pure `--remote
 *  DOC_ID` has no local file at all, so that advice would be nonsensical there. */
function rejectCommentOnCloud(cmd: string, hasLocalFile: boolean): void {
  if (cmd !== "comment") return;
  const fallback = hasLocalFile ? " — edit the file directly and `wait`." : ".";
  process.stderr.write(`inplan comment: cloud docs aren't supported yet${fallback}\n`);
  process.exit(64);
}

/** Where an `open`/`wait`/`signal` on a local path should run, per the doc's status. */
type Route = { kind: "local" } | { kind: "cloud"; docId: string } | { kind: "reconcile"; docId: string };

/**
 * Decide whether a local-path command runs locally or follows the doc to the
 * cloud. A `cloud` status routes to the Supabase backend — unless the on-disk
 * file has diverged from the last sync (downloaded or hand-edited), in which case
 * we surface a reconcile so the human can choose to continue locally. `signal`
 * and a missing file never reconcile (there is nothing to compare).
 */
function routeFor(file: string, cmd: string, args: string[]): Route {
  const p = docPaths(file);
  const status = readStatus(p.statusPath);
  if (status.location !== "cloud" || !status.cloudDocId) return { kind: "local" };
  const docId = status.cloudDocId;
  // `signal` and `message` are lightweight agent→editor events with nothing to compare,
  // so they skip the reconcile gate (like a missing file) and go straight to the cloud backend.
  if (cmd === "signal" || cmd === "message" || !existsSync(file)) return { kind: "cloud", docId };

  const local = readFileSync(file, "utf8");
  const diverged = status.lastSyncedHash !== undefined && hashBody(local) !== status.lastSyncedHash;
  if (!diverged || hasFlag(args, "use-cloud")) return { kind: "cloud", docId };
  if (hasFlag(args, "continue-locally")) {
    writeStatus(p.statusPath, { location: "local", originalPath: file, lastSyncedHash: hashBody(local) });
    return { kind: "local" };
  }
  return { kind: "reconcile", docId };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0];

  if (cmd === "--version" || cmd === "-v") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  if (cmd === "login") {
    await doLogin(argv.slice(1));
    return;
  }
  if (cmd === "whoami") {
    await doWhoami();
    return;
  }
  if (cmd === "profile") {
    await doProfile(argv.slice(1));
    return;
  }
  if (cmd === "token") {
    await doToken();
    return;
  }
  if (cmd === "install-skill") {
    doInstallSkill(argv.slice(1));
    return;
  }
  if (cmd === "logout") {
    doLogout();
    return;
  }
  // Self-update over npm (inplan ships as a global npm install).
  if (cmd === "update") {
    const updArgs = argv.slice(1);
    const pkg = getFlag(updArgs, "pkg") ?? UPDATE_PKG;
    if (hasFlag(updArgs, "check")) {
      output({ status: "update_check", pkg, ...(await checkForUpdate({ pkg, current: VERSION })) });
    } else {
      const r = await selfUpdate(pkg);
      output({ status: r.ok ? "updated" : "update_failed", pkg, output: r.output });
    }
    return;
  }

  // Flags are parsed from everything after the subcommand (`argv.slice(1)`), so a
  // cloud invocation (`wait --remote DOC_ID`) and a local one (`wait file.md --cursor N`)
  // both resolve their flags regardless of whether arg 1 is a path or a flag.
  const args = argv.slice(1);
  const cursorFlag = getFlag(args, "cursor");
  const explicitCursor = cursorFlag !== undefined ? Number(cursorFlag) : null; // optional override; wait self-manages otherwise
  const model = getFlag(args, "model"); // the agent declares its model (presence badge + comment author)
  const confirmed = new Set(
    (getFlag(args, "confirmed-comment-deletion") ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );

  if (!cmd || !["open", "wait", "signal", "message", "comment", "relay", "status", "promote", "demote", "upload", "asset-upload"].includes(cmd)) {
    process.stderr.write(
      "usage: inplan open  <file>   (create/open a local plan in the editor)\n" +
        "       inplan wait   <file|--remote DOC_ID> [--model NAME] [--cursor N] [--confirmed-comment-deletion=a,b] [--done] [--reload]\n" +
        "       inplan signal <file|--remote DOC_ID> [--done] [--reload]\n" +
        '       inplan message <file> "your message"   (relay a note to the editor status bar)\n' +
        "       inplan comment <file> (--parent-id <id>|--doc|--span \"text\") --text \"...\" [--model NAME] [--may-resolve] [--question <json>]\n" +
        "       inplan relay [--hook <kind> | --text <s> [--activity]]   (agent-hook → editor; resolves the active doc)\n" +
        "       inplan status  <file>\n" +
        "       inplan upload  <file> [--org <slug>] [--repo <name>] [--path <p>] [--evict-lru]   (Collaborate on Cloud)\n" +
        "       inplan promote <file> --cloud-doc <docId> [--locator org/repo/path]\n" +
        "       inplan demote  <file> [--from-store]   (bring a cloud doc back to disk; --from-store accepts the server copy when the hub is unreadable)\n" +
        "       inplan asset-upload <file> --bytes-file <path> [--ext <ext>]   (cloud doc: paste/pick an image straight to storage)\n" +
        "       inplan login   (opens the browser to sign in; or --url <url> --anon <key> --refresh <token> for scripts)\n" +
        "       inplan whoami | logout\n",
    );
    process.exit(64);
  }

  // `relay` takes no <file> — it resolves the active doc from the CWD itself (it's an
  // agent-hook target, fired wherever the agent runs).
  if (cmd === "relay") {
    await doRelay(args);
    return;
  }

  // Cloud target: `--remote DOC_ID` routes to the Supabase backend instead of
  // resolving a local file/sidecar.
  const remoteDocId = getFlag(args, "remote");
  if (remoteDocId) {
    rejectCommentOnCloud(cmd, false);
    // `open` and `wait` are the same over the cloud backend — a cloud doc has no local
    // editor to launch, which is the only thing `open` adds locally. So `open --remote`
    // is deprecated: warn and behave exactly as `wait --remote`.
    const remoteCmd = cmd === "open" ? "wait" : cmd;
    if (cmd === "open") {
      process.stderr.write("inplan: `open --remote` is deprecated (a cloud doc has no local editor to launch) — use `wait --remote`. Attaching as `wait`.\n");
    }
    await runRemote(remoteCmd, remoteDocId, explicitCursor, confirmed, args, undefined, model);
    return;
  }

  // Resolve to an absolute path up front so the CLI and the editor it spawns
  // compute the same sidecar key (the editor resolves its arg against its own CWD).
  const file = argv[1] ? resolve(argv[1]) : argv[1];
  if (!file) {
    process.stderr.write(`inplan ${cmd}: missing <file>\n`);
    process.exit(64);
  }

  // Location-state commands operate on the local sidecar pointer.
  if (cmd === "status") {
    doStatus(file);
    return;
  }
  if (cmd === "upload") {
    await doUpload(file, args);
    return;
  }
  if (cmd === "promote") {
    doPromote(file, args);
    return;
  }
  if (cmd === "demote") {
    await doDemote(file, args);
    return;
  }
  if (cmd === "asset-upload") {
    await doAssetUpload(file, args);
    return;
  }

  // Follow the doc to wherever it lives: a `cloud` status drives the Supabase
  // backend (reconciling first if the on-disk copy diverged); otherwise local.
  const route = routeFor(file, cmd, args);
  if (route.kind === "reconcile") {
    output({
      status: "reconcile_required",
      message:
        "Local file differs from the last cloud sync. Re-run with --continue-locally to switch this doc back to local, or --use-cloud to keep collaborating in the cloud.",
      path: file,
      cloudDocId: route.docId,
    });
    return;
  }
  if (route.kind === "cloud") {
    rejectCommentOnCloud(cmd, true);
    // `file` is this promoted local doc — pass it so a Save-locally request can
    // bring the body back to disk here.
    await runRemote(cmd, route.docId, explicitCursor, confirmed, args, file, model);
    return;
  }

  if (cmd === "signal") {
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    const channel = new FsControlChannel(p);
    if (hasFlag(args, "done")) {
      await channel.append({ actor: "agent", type: LogEventType.AgentDoneSuggested });
    }
    // Ask the human to close the window so the agent can relaunch a new build —
    // a clean, user-initiated shutdown instead of the agent killing the process.
    if (hasFlag(args, "reload")) {
      await channel.append({ actor: "agent", type: LogEventType.ReloadSuggested });
    }
    output({ status: "signaled" });
    return;
  }

  // Relay a human-facing note to the editor's status bar (informational; not a wake
  // signal). Usage: `inplan message <file> "text"`.
  if (cmd === "message") {
    const text = (argv[2] ?? "").trim();
    if (!text) {
      process.stderr.write('inplan message: usage: inplan message <file> "your message"\n');
      process.exit(1);
    }
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    const channel = new FsControlChannel(p);
    await channel.append({ actor: "agent", type: LogEventType.AgentMessage, payload: { text } });
    output({ status: "messaged" });
    return;
  }

  // `open` is the one command that may be handed a not-yet-existing path: it creates the empty
  // doc below (open-then-fill). Every other command needs the file to already exist.
  if (cmd !== "open" && !existsSync(file)) {
    process.stderr.write(`inplan ${cmd}: file not found: ${file}\n`);
    process.exit(1);
  }

  // Append a comment (reply/answer, document-level, or span-anchored) with the CLI's own real
  // timestamp, instead of the agent hand-writing the JSON block (and having to invent the `date`
  // field itself — see ./commentAdd.ts). Just rewrites the file; the agent's next `wait` picks it
  // up like any other edit. Usage: `inplan comment <file> (--parent-id <id>|--doc|--span "text")
  // --text "..." [--model NAME] [--may-resolve] [--question <json>]`.
  if (cmd === "comment") {
    const text = getFlag(args, "text");
    if (!text) {
      process.stderr.write(
        'inplan comment: usage: inplan comment <file> (--parent-id <id>|--doc|--span "exact body text") --text "..." [--model NAME] [--may-resolve] [--question <json>]\n',
      );
      process.exit(64);
    }
    const parentId = getFlag(args, "parent-id");
    const span = getFlag(args, "span");
    const questionRaw = getFlag(args, "question");
    let question: unknown;
    if (questionRaw !== undefined) {
      try {
        question = JSON.parse(questionRaw);
      } catch {
        process.stderr.write("inplan comment: --question must be valid JSON\n");
        process.exit(64);
      }
    }
    try {
      // Plain read-modify-write, no lock: a concurrent save from the human (e.g. Instant mode,
      // live editing) in this window is a last-writer-wins race — no worse than a hand-edit via
      // Edit/Write ever was, but worth naming now that this is a fast, easily-repeatable command
      // rather than a one-off manual edit.
      const currentText = readFileSync(file, "utf8");
      const { text: nextText, comment } = addComment(currentText, {
        text,
        author: agentAuthorFor(model),
        ...(parentId ? { parentId } : {}),
        ...(hasFlag(args, "doc") ? { doc: true } : {}),
        ...(span ? { span } : {}),
        ...(question ? { question } : {}),
        mayResolve: hasFlag(args, "may-resolve"),
      });
      writeFileSync(file, nextText);
      output({ status: "commented", id: comment.id, date: comment.date, author: comment.author });
    } catch (err) {
      if (err instanceof AddCommentError) {
        process.stderr.write(`${err.message}\n`);
        process.exit(64);
      }
      throw err;
    }
    return;
  }

  if (cmd === "open") {
    ensureDocFile(file); // a fresh path → create an empty doc, so open-then-fill works without a separate write
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
    // Record this local doc's path in its status so the agent-console relay can resolve
    // "the doc being worked on in this CWD" later (doesn't disturb a cloud-promoted status).
    const st = readStatus(p.statusPath);
    if (st.location !== "cloud") writeStatus(p.statusPath, { ...st, location: "local", originalPath: file });
    const existing = runningEditorPid(p.logPath);
    if (existing !== null) {
      process.stderr.write(`[inplan] an editor is already open for this document (pid ${existing}); attaching without launching another window\n`);
    } else {
      const pid = spawnApp(file);
      if (pid !== null) {
        await new FsControlChannel(p).append({ actor: "agent", type: LogEventType.EditorPid, payload: { pid, v: CONTROL_LOG_VERSION } });
      }
    }
  }

  // If a runtime plugin is active for this doc (status.pluginSession, published by the entitled
  // desktop app), gate the agent through the plugin instead of the .md. The loader verifies the
  // user's entitlement + the signed plugin bundle before loading it; unverified / not entitled /
  // logged out ⇒ null ⇒ the file-backed gate. Only local docs (not cloud) carry a plugin session.
  let gate: PluginGate | null = null;
  const pluginSession = readStatus(docPaths(file).statusPath).pluginSession;
  if (pluginSession) {
    const session = await authedSession();
    gate = await loadPluginGate(pluginSession, { token: session?.session.access_token ?? null });
  }
  await waitCycle(fsBackend(file), explicitCursor, confirmed, model, gate);
}

// Run the CLI only when this module IS the invoked program — i.e. `node dist/cli.js …` or the
// `inplan` bin. When a test imports it to exercise a command handler (e.g. doUpload), it's not the
// entry, so main() must not dispatch argv. We compare import.meta.url to argv[1] (realpath-resolved
// so the bin symlink matches). NB: a VITEST env check would be wrong — the CLI integration tests
// spawn the built CLI as a child that inherits VITEST, which would then wrongly suppress main().
function isProgramEntry(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return import.meta.url === pathToFileURL(argv1).href;
  }
}
if (isProgramEntry()) {
  // Backstop: stdout is the agent's JSON channel, so NOTHING may reach it as a raw Node stack trace.
  // An unhandled rejection anywhere (a stray promise in a poll loop, a listener callback) otherwise
  // kills the process under Node's default `--unhandled-rejections=throw`, leaving the agent with an
  // exit code, a stack trace on stderr, and no parseable result at all.
  // Latch: `exitAfterFlush` only SCHEDULES the exit, so concurrent rejections would each emit their
  // own JSON before the process actually goes — breaking the one-object-per-run stdout contract the
  // agent parses. First one wins; the rest are dropped.
  let exitingForUnhandledRejection = false;
  process.on("unhandledRejection", (reason) => {
    if (exitingForUnhandledRejection) return;
    exitingForUnhandledRejection = true;
    const message = reason instanceof Error ? reason.message : String(reason);
    process.stderr.write(`inplan: unexpected error — ${message}\n`);
    output({ status: "internal_error", message });
    exitAfterFlush(1);
  });
  main().catch((err) => {
    process.stderr.write(`inplan: ${(err as Error).message}\n`);
    output({ status: "internal_error", message: (err as Error).message });
    exitAfterFlush(1);
  });
}
