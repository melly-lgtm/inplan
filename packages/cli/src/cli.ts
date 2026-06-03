#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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
import { checkForUpdate, selfUpdate, UPDATE_PKG } from "./update";
import { runningEditorPid } from "./editorProcess";
import { evaluateAgentEdit } from "./gate";
import { docPaths, type DocPaths } from "./paths";
import { wakePredicate, waitForActions } from "./wait";

const VERSION = "0.1.1";

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
 * Locate the Electron editor bundled alongside this CLI in the published `inplan`
 * package (layout: `bin/cli.js` + `app/main/index.js`, with `electron` as a dependency).
 * Returns the electron binary + the app entry, or null when running from source/dev
 * (no sibling `app/` or electron) — then `INPLAN_APP_CMD` is the only way to launch.
 */
function resolveBundledApp(): { electron: string; appMain: string } | null {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const appMain = join(here, "..", "app", "main", "index.js");
    if (!existsSync(appMain)) return null;
    const electron = createRequire(import.meta.url)("electron") as unknown;
    return typeof electron === "string" ? { electron, appMain } : null;
  } catch {
    return null;
  }
}

function spawnApp(file: string): number | null {
  // Prefer an explicit override (dev: points at electron-vite); otherwise launch the
  // app bundled in the published package via its electron dependency.
  const override = process.env.INPLAN_APP_CMD;
  const bundled = override ? null : resolveBundledApp();
  if (!override && !bundled) {
    process.stderr.write("[inplan] no editor available (set INPLAN_APP_CMD, or install the published `inplan` package); running headless\n");
    return null;
  }
  // Pass our own entry path so the editor can shell back out to the CLI for the
  // cloud actions (whoami / upload / logout / token) it surfaces in the profile menu.
  const env = { ...process.env, INPLAN_CLI: process.argv[1] ?? "" };
  const child = override
    ? spawn(override, [file], { detached: true, stdio: "ignore", shell: true, env })
    : spawn(bundled!.electron, [bundled!.appMain, file], { detached: true, stdio: "ignore", env });
  child.unref();
  return child.pid ?? null;
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

/** Latest agent-change acceptance from the protocol history (Auto unless a mode_changed says Review). */
function acceptanceFrom(entries: LogEntry[]): "auto" | "review" {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.ModeChanged) {
      const a = (entries[i]!.payload as { acceptance?: string } | undefined)?.acceptance;
      if (a === "auto" || a === "review") return a;
    }
  }
  return "auto";
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
function doLogin(args: string[]): void {
  const url = getFlag(args, "url") ?? process.env.INPLAN_SUPABASE_URL;
  const anonKey = getFlag(args, "anon") ?? process.env.INPLAN_SUPABASE_ANON_KEY;
  const refreshToken = getFlag(args, "refresh");
  if (!url || !anonKey || !refreshToken) {
    process.stderr.write("usage: inplan login --url <url> --anon <anon-key> --refresh <refresh-token> [--email <e>]\n");
    process.exit(64);
  }
  const email = getFlag(args, "email");
  saveAuth({ url, anonKey, refreshToken, ...(email ? { email } : {}) });
  output({ status: "logged_in", url, ...(email ? { email } : {}) });
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
  output({ signedIn: true, id: user.id, ...(user.email ? { email: user.email } : {}) });
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
 *  feature). */
function bundledSkillPath(): string | null {
  try {
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
function skillTargets(): { name: string; root: string; target: string }[] {
  const home = homedir();
  return [
    { name: "Claude Code", root: join(home, ".claude"), target: join(home, ".claude", "skills", "inplan", "SKILL.md") },
    { name: "Pi", root: join(home, ".pi", "agent"), target: join(home, ".pi", "agent", "skills", "inplan", "SKILL.md") },
    { name: "Codex", root: join(home, ".codex"), target: join(home, ".codex", "skills", "inplan", "SKILL.md") },
  ];
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
      if (existsSync(a.target)) continue; // already present → idempotent, never clobber
      mkdirSync(dirname(a.target), { recursive: true });
      copyFileSync(src, a.target);
      installed.push(a.name);
      process.stderr.write(`inplan: installed the inplan skill into ${a.name} (${a.target}). Set INPLAN_NO_SKILL_INSTALL=1 to skip.\n`);
    } catch {
      /* never fail an install over a skill copy */
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
  if (cmd === "signal" || !existsSync(file)) return { kind: "cloud", docId };

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
    doLogin(argv.slice(1));
    return;
  }
  if (cmd === "whoami") {
    await doWhoami();
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

  if (!cmd || !["open", "wait", "signal", "status", "promote", "demote", "upload"].includes(cmd)) {
    process.stderr.write(
      "usage: inplan <open|wait|signal> <file|--remote DOC_ID> [--model NAME] [--cursor N] [--confirmed-comment-deletion=a,b] [--done] [--reload]\n" +
        "       inplan status  <file>\n" +
        "       inplan upload  <file> [--org <slug>] [--repo <name>] [--path <p>]   (Collaborate on Cloud)\n" +
        "       inplan promote <file> --cloud-doc <docId> [--locator org/repo/path]\n" +
        "       inplan demote  <file>\n" +
        "       inplan login --url <url> --anon <anon-key> --refresh <refresh-token> [--email <e>]\n" +
        "       inplan whoami | logout\n",
    );
    process.exit(64);
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

  if (!existsSync(file)) {
    process.stderr.write(`inplan ${cmd}: file not found: ${file}\n`);
    process.exit(1);
  }

  if (cmd === "open") {
    const p = docPaths(file);
    mkdirSync(p.controlDir, { recursive: true });
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
