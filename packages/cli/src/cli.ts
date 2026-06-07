#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
import { ***REMOVED***, ***REMOVED***Websocket } from "***REMOVED***";
import * as Y from ***REMOVED***;
import WebSocket from "ws";
import { agentAuthorFor } from "./agentAuthor";
import { gitProvenance } from "./provenance";
import { authedSession, clearAuth, currentUser, remoteBackend, saveAuth } from "./cliAuth";
import { resolveIdentity, setManualProfile, writeLocalProfile } from "./cliProfile";
import { checkForUpdate, selfUpdate, UPDATE_PKG } from "./update";
import { runningEditorPid } from "./editorProcess";
import { evaluateAgentEdit } from "./gate";
import { docPaths, sidecarRoot, type DocPaths } from "./paths";
import { wakePredicate, waitForActions } from "./wait";
import { versionFromModule } from "./version";
import { toolActivityText } from "./relayActivity";
import { ensureDocFile } from "./ensureDoc";
import { trackCli } from "./telemetry";

// Version is read from the adjacent package.json (see ./version) so a release bumps one place.
const VERSION = versionFromModule(import.meta.url);

function output(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
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

const debounceMs = Number(process.env.INPLAN_DEBOUNCE_MS ?? 3000);
const pollMs = Number(process.env.INPLAN_POLL_MS ?? 200);
const COLLAB_URL = process.env.INPLAN_COLLAB_URL || "wss://inplan-collab.fly.dev";

/**
 * Announce this local agent in a cloud doc's awareness room (***REMOVED*** presence), so
 * the web shows an "agent · your machine" badge while the CLI is attached. Agent
 * attachment is **derived from live presence, not stored** — disconnecting (the
 * wait exiting) clears it. Best-effort: presence must never break the wait, so
 * any failure is swallowed and the wait proceeds.
 */
function announcePresence(docId: string, token: string, model?: string): { destroy: () => void } {
  try {
    const ydoc = new ***REMOVED***();
    // Node has no DOM WebSocket; hand the socket the `ws` polyfill.
    const socket = new ***REMOVED***Websocket({ url: COLLAB_URL, WebSocketPolyfill: WebSocket });
    const provider = new ***REMOVED***({ websocketProvider: socket, name: docId, document: ydoc, token });
    provider.awareness?.setLocalStateField("inplanPresence", { kind: "agent", agentLocation: "local", ...(model ? { model } : {}) });
    return {
      destroy: () => {
        try {
          provider.destroy();
          socket.destroy();
          ydoc.destroy();
        } catch {
          /* best-effort teardown */
        }
      },
    };
  } catch {
    return { destroy: () => {} };
  }
}

/**
 * Result of locating the Electron editor bundled alongside this CLI in the published
 * `inplan` package (layout: `bin/cli.js` + `app/main/index.js`, with `electron` as a
 * dependency): ready-to-launch, no-bundled-app (source/dev), or app-present-but-no-runtime
 * (e.g. electron's binary never downloaded). spawnApp turns each into the right action/message.
 */
type BundledApp =
  | { electron: string; appMain: string } // ready to launch
  | { appMain: null } // no bundled app (running from source/dev)
  | { appMain: string; error: string }; // app present, but its Electron runtime is unavailable

function resolveBundledApp(): BundledApp {
  const here = dirname(fileURLToPath(import.meta.url));
  const appMain = join(here, "..", "app", "main", "index.js");
  if (!existsSync(appMain)) return { appMain: null }; // source/dev — no sibling app/
  try {
    // require("electron") outside Electron returns the path to its binary — but throws
    // ("Electron failed to install correctly") if the binary never downloaded (a blocked
    // proxy/AV download is the usual culprit on a fresh global install).
    const electron = createRequire(import.meta.url)("electron") as unknown;
    if (typeof electron === "string" && electron) return { electron, appMain };
    return { appMain, error: "the electron dependency did not resolve to a runtime path" };
  } catch (e) {
    return { appMain, error: e instanceof Error ? e.message : String(e) };
  }
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

/** Latest cadence from the protocol history (Turn unless a mode_changed says otherwise). */
function cadenceFrom(entries: LogEntry[]): "turn" | "instant" {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.ModeChanged) {
      const c = (entries[i]!.payload as { cadence?: string } | undefined)?.cadence;
      if (c === "instant" || c === "turn") return c;
    }
  }
  return "turn";
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
interface WaitBackend {
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
async function waitCycle(backend: WaitBackend, explicitCursor: number | null, confirmed: Set<string>, model?: string): Promise<void> {
  const { channel, store } = backend;
  const history = await backend.history();

  // Cursor: explicit override, else the persisted cursor, else "start from now".
  // getCursor() returns 0 when unset, so `|| maxSeqFrom` means begin at the latest seq.
  const cursor = explicitCursor ?? ((await channel.getCursor()) || maxSeqFrom(history));

  const current = await store.loadDoc();
  let canonicalText = await store.getCanonical();
  if (canonicalText === null) {
    canonicalText = current;
    await store.setCanonical(current);
  }

  const ev = evaluateAgentEdit(canonicalText, current, confirmed);
  if (ev.unconfirmed.length > 0) {
    output({
      status: "confirm_required",
      message: "Edit removes anchored comment(s). Re-run wait with --confirmed-comment-deletion=<ids> to proceed.",
      lost: ev.unconfirmed.map((c) => ({ id: c.id, text: c.text, author: c.author })),
    });
    process.exit(3);
  }
  if (!ev.integrityOk) {
    output({ status: "integrity_error", errors: ev.integrityErrors });
    process.exit(2);
  }
  // In Review mode an agent **body** change is quarantined as a proposal rather
  // than applied: the working file + canonical stay put, the agent's version is
  // parked in `.proposed.md`, and `agent_revision_proposed` is logged. The human
  // accepts/rejects in the editor (which then writes canonical). This makes the
  // file the source of truth WITHOUT auto-applying — killing the app before a
  // decision leaves the proposal pending, never silently accepted.
  const acceptance = acceptanceFrom(history);
  const bodyChanged = parse(canonicalText).body !== parse(current).body;

  if (ev.removedIds.length > 0) {
    // Confirmed deletions: drop the orphaned comment objects from the document and canonical base.
    await store.saveDoc(ev.acceptedText);
    await store.setCanonical(ev.acceptedText);
    await store.clearProposed();
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { removed: ev.removedIds } });
  } else if (ev.changed && acceptance === "review" && bodyChanged) {
    // Quarantine: park the proposal, revert the working file to canonical.
    await store.setProposed(current);
    await store.saveDoc(canonicalText);
    await channel.append({ actor: "agent", type: LogEventType.AgentRevisionProposed, payload: { bytes: current.length } });
  } else if (ev.changed) {
    // Auto-accept (auto mode, or review mode with comment-only changes).
    await store.setCanonical(current);
    await store.clearProposed();
    await channel.append({ actor: "agent", type: LogEventType.DocumentEdited, payload: { bytes: current.length } });
  }

  // Signal the agent has (re)engaged this round so the editor can clear its
  // "Agent is thinking…" indicator even when the agent made no body change.
  await channel.append({ actor: "agent", type: LogEventType.AgentRevised });

  // Single-waiter lock: claim the doc so any older waiter steps down (no racing
  // double-waiters). Log the exit reason — including OS signals — so a reaped
  // waiter is diagnosable instead of "vanishing" silently.
  // Last writer wins — any older waiter sees the token change and steps down.
  const lockToken = `${process.pid}-${Date.now()}`;
  await channel.claimLock(lockToken);
  for (const sig of ["SIGTERM", "SIGHUP", "SIGINT"] as const) {
    process.on(sig, () => {
      backend.logExit(`signal:${sig}`);
      process.exit(0);
    });
  }

  // Mode-aware wake: Turn mode wakes only on turn-end / session-close; Instant on any user action.
  const cadence = cadenceFrom(history);
  const isActionable = wakePredicate(cadence);
  const result = await waitForActions({ channel, cursor, debounceMs, pollMs, isActionable, token: lockToken });

  // Superseded: a newer waiter owns the doc now. Step down quietly without
  // advancing the cursor (the live waiter handles it).
  if (result.superseded) {
    backend.logExit("superseded");
    output({ status: "superseded" });
    return;
  }

  await channel.setCursor(result.cursor); // advance the persisted cursor so the next call continues here

  // Cloud→local handoff: a human on the web asked us to bring the doc back to disk.
  // The backend's handler downloads + relocates + flips status and emits its own
  // result, so we hand off instead of printing the normal turn status.
  if (backend.onSaveLocally && result.entries.some((e) => e.type === LogEventType.SaveLocallyRequested)) {
    backend.logExit("save_locally");
    await backend.onSaveLocally();
    return;
  }

  // In-window navigation: the editor followed a link to a sibling doc and parked a
  // `navigated_to {path}`. Step down here and report the new path so the agent loop
  // re-attaches there (`wait <path>`), following the human across docs.
  const navEntry = result.entries.find((e) => e.type === LogEventType.NavigatedTo);
  if (navEntry) {
    const path = (navEntry.payload as { path?: string } | undefined)?.path;
    backend.logExit("navigated");
    output({ status: "navigated", ...(path ? { path } : {}), cursor: result.cursor, closed: false });
    return;
  }

  // The editor logs WHY it closed (completed / window_closed); a crash logs nothing.
  const closeEntry = result.entries.find((e) => e.type === LogEventType.SessionClosed);
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
    status = cadence === "turn" ? "your_turn" : "activity";
  }
  backend.logExit(`status:${status}${reason ? `/${reason}` : ""}`);
  output({
    status,
    mode: cadence,
    humanLocked: status === "your_turn",
    // Materialized current settings (global file + this session's settings_changed),
    // so the agent always has them without scanning the log history.
    settings: settingsFromEntries(history),
    // The canonical name the agent should author comments under (model-qualified
    // when --model was passed), so presence + authorship stay consistent.
    agentAuthor: agentAuthorFor(model),
    ...(reason ? { reason } : {}),
    cursor: result.cursor,
    closed: status === "closed",
    entries: result.entries,
  });
}

/**
 * Store cloud credentials for `--remote` commands. Flags win over env so a shell
 * can pre-seed the deployment (`INPLAN_SUPABASE_URL` / `_ANON_KEY`) and only the
 * per-user `--refresh` token need be passed. (The browser handoff — `inplan login`
 * opens `/cli-auth` and receives the token — is a later slice; this is the seam.)
 */
async function doLogin(args: string[]): Promise<void> {
  const url = getFlag(args, "url") ?? process.env.INPLAN_SUPABASE_URL;
  const anonKey = getFlag(args, "anon") ?? process.env.INPLAN_SUPABASE_ANON_KEY;
  const refreshToken = getFlag(args, "refresh");
  if (!url || !anonKey || !refreshToken) {
    process.stderr.write("usage: inplan login --url <url> --anon <anon-key> --refresh <refresh-token> [--email <e>]\n");
    process.exit(64);
  }
  const email = getFlag(args, "email");
  saveAuth({ url, anonKey, refreshToken, ...(email ? { email } : {}) });
  // Capture the cloud account's identity locally so comments are authored as the
  // signed-in user (overrides any earlier git/manual profile on explicit login).
  await persistCloudIdentity();
  output({ status: "logged_in", url, ...(email ? { email } : {}) });
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
 * Drive a *cloud* document as the logged-in agent. There is no local editor to
 * spawn (a cloud doc opens in the browser), so `open`/`wait` both attach + wait
 * over the Supabase backend, and `signal` appends the agent's protocol events.
 *
 * `localFile` is set only when we reached the cloud by *following a promoted local
 * file's status* — it enables the Save-locally handoff (download the doc back to
 * its original path on disk). The bare `--remote <docId>` case has no local file.
 */
async function runRemote(cmd: string, docId: string, explicitCursor: number | null, confirmed: Set<string>, rest: string[], localFile?: string, model?: string): Promise<void> {
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

  // Save-locally handoff (only when following a promoted local file): download the
  // live body to its original path, flip the status back to local, reopen the local
  // editor, and report — the inverse of "Collaborate on Cloud".
  const onSaveLocally = localFile
    ? async () => {
        const body = await backend.store.loadDoc();
        writeFileSync(localFile, body);
        writeStatus(docPaths(localFile).statusPath, { location: "local", originalPath: localFile, lastSyncedHash: hashBody(body) });
        const pid = spawnApp(localFile); // reopen the doc in the local editor
        output({ status: "moved_local", path: localFile, reopened: pid !== null });
      }
    : undefined;

  // While we hold the turn on a cloud doc, announce the local agent in the doc's
  // presence room so the web badge shows "agent · your machine"; clear it on exit.
  const presence = announcePresence(docId, backend.token, model);
  try {
    await waitCycle(
      {
        channel: backend.channel,
        store: backend.store,
        history: async () => (await backend.channel.readSince(0)).entries,
        logExit: () => {}, // no local sidecar for a cloud doc
        ...(onSaveLocally ? { onSaveLocally } : {}),
      },
      explicitCursor,
      confirmed,
      model,
    );
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
  const body = await backend.store.loadDoc();
  const dest = st.originalPath ?? file;
  writeFileSync(dest, body);
  writeStatus(p.statusPath, { location: "local", originalPath: dest, lastSyncedHash: hashBody(body) });
  output({ status: "demoted", location: "local", path: dest });
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
const SKILL_ALLOW = ["Bash(inplan *)", "Edit(**/*.plan.md)", "Write(**/*.plan.md)", "Read(~/.inplan/**)", "Edit(~/.inplan/**)", "Write(~/.inplan/**)"];
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
  const allow = Array.isArray(perms.allow) ? (perms.allow as string[]) : [];
  const dirs = Array.isArray(perms.additionalDirectories) ? (perms.additionalDirectories as string[]) : [];
  let changed = false;
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
async function doUpload(file: string, args: string[]): Promise<void> {
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

  const { data: doc, error: de } = await s.db
    .from("documents")
    // Stamp the owner (M4.8 doc scope): the uploader owns the doc, so it can later be
    // made `access=personal` (owner-only) vs the default `org` (shared). Additive —
    // new docs stay org-shared until the owner narrows them.
    .insert({ org_id: pick.org_id, owner_id: s.session.user.id, title, repo, path, body })
    .select("id")
    .single();
  if (de || !doc) {
    process.stderr.write(`inplan upload: ${de?.message ?? "could not create the cloud document"}\n`);
    process.exit(1);
  }
  const cloudDocId = (doc as { id: string }).id;

  const status: DocStatus = {
    location: "cloud",
    cloudDocId,
    originalPath: file,
    lastSyncedHash: hashBody(body),
    ...(org?.slug ? { cloudLocator: { org: org.slug, repo, path } } : {}),
  };
  writeStatus(docPaths(file).statusPath, status);
  output({ status: "uploaded", cloudDocId, ...(org?.slug ? { locator: { org: org.slug, repo, path } } : {}) });
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

  if (!cmd || !["open", "wait", "signal", "message", "relay", "status", "promote", "demote", "upload"].includes(cmd)) {
    process.stderr.write(
      "usage: inplan <open|wait|signal> <file|--remote DOC_ID> [--model NAME] [--cursor N] [--confirmed-comment-deletion=a,b] [--done] [--reload]\n" +
        '       inplan message <file> "your message"   (relay a note to the editor status bar)\n' +
        "       inplan relay [--hook <kind> | --text <s> [--activity]]   (agent-hook → editor; resolves the active doc)\n" +
        "       inplan status  <file>\n" +
        "       inplan upload  <file> [--org <slug>] [--repo <name>] [--path <p>]   (Collaborate on Cloud)\n" +
        "       inplan promote <file> --cloud-doc <docId> [--locator org/repo/path]\n" +
        "       inplan demote  <file>\n" +
        "       inplan login --url <url> --anon <anon-key> --refresh <refresh-token> [--email <e>]\n" +
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
    await runRemote(cmd, remoteDocId, explicitCursor, confirmed, args, undefined, model);
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

  await waitCycle(fsBackend(file), explicitCursor, confirmed, model);
}

main().catch((err) => {
  process.stderr.write(`inplan: ${(err as Error).message}\n`);
  process.exit(1);
});
