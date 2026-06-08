// SPDX-License-Identifier: AGPL-3.0-or-later

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { APP_ICON_DATA_URL } from "./appIcon";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { Acceptance, Cadence, SaveOptions, Settings } from "@inplan/renderer";
import { isOnboarded, markOnboarded } from "@inplan/core/node";
import { Session } from "./session";
import { createI18nController } from "./i18nController";
import { track, type TelemetryProps } from "./telemetry";
import { registerCollabScheme, handleCollabScheme, collabInfo, startDesktopCollab, stopDesktopCollab } from "./desktopCollab";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Privileged scheme for the (paid) live-collab plugin — must register before app 'ready'. No-op
// effect unless an entitled, verified bundle is later loaded (startDesktopCollab).
registerCollabScheme();

/** Mint the user's JWT for the entitlement check (the CLI owns auth; logged-out ⇒ null). */
const collabToken = (): Promise<string | null> =>
  runCli(["token"]).then((r) => {
    try {
      return (JSON.parse(r.stdout.trim() || "{}") as { token?: string }).token ?? null;
    } catch {
      return null;
    }
  });

// Identify as "inplan" instead of the default "Electron" — set before `whenReady` so the
// macOS app menu (built from app.name) and the About panel read it. (Run via the bundled
// electron binary, the dock/⌘-Tab name still comes from the binary's bundle until packaged.)
app.setName("inplan");
app.setAboutPanelOptions({ applicationName: "inplan" });

// Log main-process errors to stderr instead of Electron's default GUI error dialog.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[inplan] uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[inplan] unhandled rejection: ${String(reason)}\n`);
});

/** The plan file to open is the first non-flag CLI argument. */
function resolveTargetFile(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  // Prefer an arg that looks like a plan document; fall back to the first
  // non-flag arg. (Some launchers — e.g. Playwright's _electron — prepend flags
  // and the app path, so the bare "first non-flag" could be the app dir.)
  const candidate = args.find((a) => !a.startsWith("-") && a.endsWith(".md")) ?? args.find((a) => !a.startsWith("-"));
  if (!candidate) return null;
  const abs = resolve(candidate);
  return existsSync(abs) ? abs : null;
}

let session: Session | null = null;
let win: BrowserWindow | null = null;
let stopWatching: (() => void) | null = null;
/** Set once the user (or an internal close path) has confirmed the quit, so the
 *  close-intercept lets the window go instead of re-prompting the quit dialog. */
let quitConfirmed = false;
/** True once the renderer has finished loading and can receive the quit-confirm IPC.
 *  Until then — or if it crashes — close/quit must NOT block waiting for a dialog that
 *  can never appear, or the window would be impossible to close (force-kill only). */
let rendererReady = false;
/** One-shot fallback: if the renderer never answers `app:confirm-quit`, close anyway. */
let quitFallbackTimer: ReturnType<typeof setTimeout> | null = null;
const QUIT_CONFIRM_TIMEOUT_MS = 8000;
/** Back/forward navigation history of opened doc paths (in-window link following). */
const navHistory: string[] = [];
let navIdx = -1;

// --- Cloud profile (the shared <ProfileMenu>) ------------------------------
// The editor stays free of Supabase: cloud identity + actions are delegated to
// the `inplan` CLI (the same one that launched us), run as plain Node via
// ELECTRON_RUN_AS_NODE. `INPLAN_CLI` is the CLI's entry path, passed on spawn.

interface ActionDescriptor {
  id: string;
  label: string;
  primary?: boolean;
  danger?: boolean;
}
interface ProfileSnapshot {
  user: { name: string; email?: string } | null;
  agentLocation: "local" | "cloud" | null;
  actions: ActionDescriptor[];
  /** Where the human identity came from (cloud/git/manual), or null when unset. */
  identitySource?: "cloud" | "git" | "manual" | null;
}

/** Run an `inplan` subcommand under Electron's bundled Node, returning stdout JSON. */
function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((res) => {
    const cli = process.env.INPLAN_CLI;
    if (!cli) {
      res({ code: -1, stdout: "", stderr: "INPLAN_CLI not set" });
      return;
    }
    execFile(
      process.execPath,
      [cli, ...args],
      { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } },
      (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === "number" ? Number((err as { code: number }).code) : err ? 1 : 0;
        res({ code, stdout, stderr });
      },
    );
  });
}

/** Base URL of the cloud edition (inplan.ai), for the reachability probe + cloud links. */
const CLOUD_BASE = (process.env.INPLAN_WEB_URL || "https://inplan.ai").replace(/\/$/, "");

// Localization (paid perk): fetched from the cloud via the CLI's token, entitlement-gated.
// English-only until a signed-in, entitled session is verified online. See i18nController.
const i18n = createI18nController({
  runCli: (args) => runCli(args).then((r) => ({ stdout: r.stdout })),
  cloudBase: CLOUD_BASE,
  onChange: () => win?.webContents.send("i18n:changed"),
});

// Cloud linking. The desktop app is local-first, so cloud affordances (sign in,
// collaborate) only appear when inplan.ai is both reachable AND advertising the cloud
// link as enabled — its health endpoint returns `link_enabled`, a server-side kill
// switch. While it's false (the default), the app shows nothing cloud-related, so
// open-core users aren't funneled toward the cloud. We cache the result; readProfile
// reads the cache (never blocks), and a background re-probe refreshes the menu whenever
// the flag flips.
let cloudLinkEnabled = false;
let lastCloudProbe = 0;
const CLOUD_PROBE_TTL_MS = 60_000;

async function probeCloud(): Promise<void> {
  lastCloudProbe = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  let enabled = false;
  try {
    const res = await fetch(`${CLOUD_BASE}/api/v1/healthz`, { signal: ctrl.signal });
    const body = (res.ok ? await res.json().catch(() => null) : null) as { link_enabled?: boolean } | null;
    enabled = body?.link_enabled === true; // reachable AND link explicitly enabled
  } catch {
    enabled = false; // offline / DNS failure / timeout / cloud down → no cloud chrome
  } finally {
    clearTimeout(timer);
  }
  if (enabled !== cloudLinkEnabled) {
    cloudLinkEnabled = enabled;
    win?.webContents.send("profile:changed"); // re-render the menu (cloud chrome on/off)
  }
}

/** Kick a background reachability probe if the cached result is stale (never blocks). */
function ensureCloudProbe(): void {
  if (Date.now() - lastCloudProbe > CLOUD_PROBE_TTL_MS) void probeCloud();
}

/** The profile: the resolved human identity (works offline) + the actions to offer. */
async function readProfile(): Promise<ProfileSnapshot> {
  ensureCloudProbe();

  // 1) Resolve the human identity (stored → cloud → git of the doc dir). This works
  //    offline and is what authors comments, independent of the cloud link.
  const idArgs = ["profile", ...(session ? [session.paths.file] : [])];
  let id: { name?: string; email?: string; source?: "cloud" | "git" | "manual" } = {};
  try {
    id = JSON.parse((await runCli(idArgs)).stdout.trim() || "{}");
  } catch {
    /* unset / unparseable → no identity yet (the menu prompts to set one) */
  }
  const user = id.name ? { name: id.name, ...(id.email ? { email: id.email } : {}) } : null;

  // Editing the local identity is rendered by the menu itself (host-agnostic), so it
  // isn't a host action. Cloud chrome below is gated by the kill switch.
  const actions: ActionDescriptor[] = [];

  // 2) Cloud chrome, gated by the kill switch: add sign-in/out + collaborate only
  //    when the link is enabled (reachable AND turned on).
  if (cloudLinkEnabled) {
    let who: { signedIn?: boolean } = {};
    try {
      who = JSON.parse((await runCli(["whoami"])).stdout.trim() || "{}");
    } catch {
      /* treat unparseable as signed out */
    }
    if (who.signedIn) {
      actions.push({ id: "collaborate", label: "Collaborate on Cloud", primary: true }, { id: "signout", label: "Sign out", danger: true });
    } else {
      actions.push({ id: "signin", label: "Sign in…" });
    }
  }

  return { user, agentLocation: null, actions, identitySource: id.source ?? null };
}

/** Collaborate on Cloud: persist the latest body, upload+promote via the CLI,
 *  open the cloud URL, and quit so the agent's next `wait` follows it to the cloud. */
async function collaborateOnCloud(): Promise<void> {
  if (!session) return;
  if (session.hasUnsaved) session.complete(session.pending); // upload the latest on-disk body
  const r = await runCli(["upload", session.paths.file]);
  let out: { status?: string; cloudDocId?: string; locator?: { org: string; repo: string; path: string } } = {};
  try {
    out = JSON.parse(r.stdout.trim() || "{}");
  } catch {
    /* fall through to the error dialog */
  }
  if (out.status !== "uploaded" || !out.cloudDocId) {
    dialog.showMessageBoxSync(win!, { type: "error", message: "Couldn't move this plan to the cloud.", detail: r.stderr.trim() || "Are you signed in? Run `inplan login`." });
    return;
  }
  const url = out.locator ? `${CLOUD_BASE}/docs/${out.locator.org}/${out.locator.repo}/${out.locator.path}` : `${CLOUD_BASE}/?doc=${out.cloudDocId}`;
  await shell.openExternal(url);
  // The doc now lives in the cloud; close this window (the running wait reconnects there).
  quitNow("window_closed");
}

/** On launch, ask the CLI whether a newer npm version is published; if so, tell
 *  the renderer so it can offer an in-app update (inplan ships via `npm i -g`). */
async function checkForUpdate(): Promise<void> {
  const r = await runCli(["update", "--check"]);
  try {
    const out = JSON.parse(r.stdout.trim() || "{}") as { updateAvailable?: boolean; current?: string; latest?: string };
    if (out.updateAvailable && out.latest) {
      win?.webContents.send("app:update-available", { current: out.current ?? "?", latest: out.latest });
    }
  } catch {
    /* no update info — ignore */
  }
}

/** Wire the current session's control-log watch to the renderer IPC channels. */
function watchSession(): (() => void) | null {
  if (!session) return null;
  const s = session;
  return s.watch({
    onExternalChange: (content) => win?.webContents.send("doc:external-change", { path: s.paths.file, content }),
    onAgentDone: () => win?.webContents.send("agent:done"),
    onAgentActive: () => win?.webContents.send("agent:active"),
    onProposal: (content) => win?.webContents.send("doc:proposal", { content }),
    onReload: () => win?.webContents.send("agent:reload"),
    onAgentMessage: (text, ts) => win?.webContents.send("agent:message", { text, ts }),
  });
}

/** Tell the renderer whether back/forward navigation is currently possible. */
function sendNavState(): void {
  win?.webContents.send("nav:state", { canBack: navIdx > 0, canForward: navIdx < navHistory.length - 1 });
}

/**
 * Follow an in-window link to a sibling doc: prompt to save unsaved edits, park
 * `navigated_to` on the CURRENT doc's log (so its attached agent steps down +
 * re-attaches at `file`), swap the window's session to `file`, and tell the
 * renderer to load it. Returns whether it actually navigated — the caller owns the
 * history/index and only advances it on success (so Cancel can't desync them).
 */
function navigateTo(file: string): boolean {
  if (!session || !win) return false;
  if (resolve(file) === resolve(session.paths.file)) return false; // already here
  // Don't silently drop the human's in-progress edits when leaving the doc.
  if (session.hasUnsaved) {
    const choice = dialog.showMessageBoxSync(win, {
      type: "question",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: "Save changes before leaving this plan?",
      detail: "Your edits this turn aren't saved to the plan yet.",
    });
    if (choice === 2) return false; // Cancel — stay put
    if (choice === 0) session.complete(session.pending); // Save → write file + canonical
    // "Don't Save" → proceed; the autosave backups remain as a safety net.
  }
  session.logNavigatedAway(file);
  stopWatching?.();
  session = new Session(file);
  session.logEditorPid(process.pid);
  stopWatching = watchSession();
  setDocTitle(file);
  void refreshCollabAndView(file);
  return true;
}

/** After a doc swap: restart the (paid) collab plugin for the new file. If it's active, reload the
 *  renderer so it re-bootstraps against the new hub (the binding is bound at editor init); else
 *  take the light file-backed path (send the new doc to the existing renderer). */
async function refreshCollabAndView(file: string): Promise<void> {
  await stopDesktopCollab();
  await startDesktopCollab(file, collabToken);
  if (!win || !session) return;
  if (collabInfo()) win.webContents.reload();
  else win.webContents.send("doc:navigated", session.load());
}

/** Record the close reason once and exit, bypassing the confirm-quit dialog.
 *  Used by the confirmed quit (app:quit) and internal close paths (cloud handoff). */
function quitNow(reason: "completed" | "window_closed"): void {
  if (quitFallbackTimer) {
    clearTimeout(quitFallbackTimer);
    quitFallbackTimer = null;
  }
  session?.logClose(reason);
  // Activation funnel: how the session ended — "completed" = switched the agent to build mode.
  track("session_closed", session?.getSettings().telemetry === true, { reason });
  quitConfirmed = true;
  app.quit();
}

/** The renderer is present and able to display the quit-confirm dialog. */
function rendererCanConfirm(): boolean {
  return !!win && !win.isDestroyed() && !win.webContents.isDestroyed() && !win.webContents.isCrashed() && rendererReady;
}

/** Arm a one-shot fallback so a hung/unresponsive renderer can never trap the user
 *  in an uncloseable window: if no `app:quit` arrives in time, close with a safe default. */
function armQuitFallback(): void {
  if (quitFallbackTimer) return;
  quitFallbackTimer = setTimeout(() => {
    quitFallbackTimer = null;
    if (!quitConfirmed) quitNow("window_closed");
  }, QUIT_CONFIRM_TIMEOUT_MS);
}

/** The inplan mark (same as inplan.ai), for the window + dock icon. */
const appIcon = nativeImage.createFromDataURL(APP_ICON_DATA_URL);

/** Window title: `inplan - <filename>` for the open doc (just `inplan` with none). */
function setDocTitle(file: string | null): void {
  win?.setTitle(file ? `inplan - ${basename(file)}` : "inplan");
}

function createWindow(): void {
  rendererReady = false; // becomes true on did-finish-load (below)
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "inplan",
    icon: appIcon, // window/taskbar icon on Windows + Linux (macOS uses the dock icon below)
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  });
  // The renderer's <title> would otherwise overwrite our window title — keep ours.
  win.on("page-title-updated", (e) => e.preventDefault());
  setDocTitle(session?.paths.file ?? null);

  // Links must never navigate the editor window. Route external links to the
  // system browser; block any in-window navigation away from the app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    if (url !== win?.webContents.getURL()) {
      event.preventDefault();
      if (/^https?:/.test(url)) void shell.openExternal(url);
    }
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // Once the renderer is up (and listening), check npm for a newer version and probe
  // cloud reachability (which gates the cloud login affordance).
  win.webContents.once("did-finish-load", () => {
    rendererReady = true; // the renderer can now receive + answer app:confirm-quit
    void checkForUpdate();
    void probeCloud();
    void i18n.bootstrap(); // load cached locale + refresh catalogs from the cloud (paid perk)
  });

  stopWatching = watchSession();

  // Closing the window (red X / Cmd+W) asks the renderer to raise the shared
  // quit dialog — Save? + Tell the agent the plan is ready? — rather than quitting
  // outright. The renderer answers via the app:quit IPC (which sets quitConfirmed).
  win.on("close", (e) => {
    if (quitConfirmed) return;
    // If the renderer can't show the dialog (still loading, crashed, or destroyed),
    // don't trap the user behind a confirm that can never appear — close safely.
    if (!rendererCanConfirm()) {
      quitNow("window_closed");
      return;
    }
    e.preventDefault();
    win!.webContents.send("app:confirm-quit");
    armQuitFallback(); // …and if the renderer never answers, close anyway after a timeout
  });

  win.on("closed", () => {
    stopWatching?.();
    void stopDesktopCollab();
    win = null;
  });
}

function registerIpc(): void {
  ipcMain.handle("doc:load", () => {
    if (!session) throw new Error("no document open");
    return session.load();
  });
  ipcMain.handle("doc:save", (_e, content: string, options: SaveOptions) => {
    session?.save(content, options);
  });
  ipcMain.handle("doc:log-action", (_e, type: string, payload?: unknown) => {
    session?.logAction(type, payload);
  });
  // Opt-in, anonymous telemetry from the renderer (gated here on the user's setting, so the
  // renderer never needs to know it). Fire-and-forget; track() no-ops when not opted in.
  ipcMain.handle("telemetry", (_e, event: string, props?: TelemetryProps) => {
    track(event, session?.getSettings().telemetry === true, props);
  });
  ipcMain.handle("doc:report-state", (_e, dirty: boolean, content: string) => {
    session?.setPending(dirty, content);
  });
  ipcMain.handle("doc:set-mode", (_e, cadence: Cadence, acceptance: Acceptance) => {
    session?.setMode(cadence, acceptance);
  });
  ipcMain.handle("settings:get", () => session?.getSettings());
  ipcMain.handle("settings:set", (_e, settings: Settings) => {
    session?.setSettings(settings);
  });
  ipcMain.handle("window:close", () => {
    // Reload / restart / update-restart close without the quit dialog — but preserve any
    // unsaved edits to disk first (the relaunched editor reloads them), so a build reload
    // never silently drops the human's in-progress turn.
    if (session?.hasUnsaved) session.complete(session.pending);
    quitConfirmed = true;
    win?.close();
  });
  ipcMain.handle("proposal:get", () => session?.pendingProposal() ?? null);
  ipcMain.handle("proposal:clear", () => {
    session?.clearProposal();
  });
  // New-doc actions (Create Doc / Move Text to New Doc): the renderer owns the body edit + the
  // (relative) link; main owns the location picker + the file write, both relative to the current
  // doc's directory so the embedded link is a normal sibling-relative Markdown link.
  const toPosix = (s: string): string => s.replace(/\\/g, "/");
  ipcMain.handle("newdoc:pick", async (_e, suggestedName: string) => {
    if (!session || !win) return null;
    const docDir = dirname(session.paths.file);
    const res = await dialog.showSaveDialog(win, {
      defaultPath: join(docDir, suggestedName || "untitled.md"),
      filters: [{ name: "Markdown", extensions: ["md"] }],
    });
    if (res.canceled || !res.filePath) return null;
    return toPosix(relative(docDir, res.filePath)); // a relative href the renderer can embed + resolve
  });
  ipcMain.handle("newdoc:create", (_e, p: string, content: string) => {
    if (!session || typeof p !== "string" || !p.trim()) return null;
    const docDir = dirname(session.paths.file);
    let abs = resolve(docDir, p);
    if (!/\.md$/i.test(abs)) abs += ".md"; // case-insensitive: don't turn "x.MD" into "x.MD.md"
    if (existsSync(abs)) return null; // never clobber an existing file — the user can pick another name
    try {
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    } catch (e) {
      process.stderr.write(`[inplan] newdoc:create failed: ${(e as Error).message}\n`);
      return null;
    }
    return { linkTarget: toPosix(relative(docDir, abs)) };
  });
  ipcMain.handle("doc:open", (_e, target: string) => {
    // `target` is the link path the renderer resolved against the current doc
    // (joined + `..`-normalized, relative to the filesystem root). Recover the
    // absolute path and swap the window to it if it's an existing .md file.
    const abs = resolve("/", target);
    if (!abs.endsWith(".md") || !existsSync(abs)) {
      process.stderr.write(`[inplan] open-doc: no such .md file: ${abs}\n`);
      return;
    }
    if (navigateTo(abs)) {
      navHistory.splice(navIdx + 1); // a fresh link drops any forward entries
      navHistory.push(abs);
      navIdx = navHistory.length - 1;
      sendNavState();
    }
  });
  ipcMain.handle("nav:go", (_e, dir: "back" | "forward") => {
    const target = dir === "back" ? navIdx - 1 : navIdx + 1;
    if (target < 0 || target >= navHistory.length) return;
    if (navigateTo(navHistory[target]!)) {
      navIdx = target; // advance the index only if we actually moved (Cancel keeps it)
      sendNavState();
    }
  });
  // The renderer's quit dialog resolved: optionally save the latest body, record
  // whether to notify the agent the plan is ready ("completed") or just close, then exit.
  ipcMain.handle("app:quit", (_e, content: string, opts: { save: boolean; startBuild: boolean }) => {
    if (opts.save) session?.complete(content); // write file + canonical
    // "Switch agent to build mode" → persist agentMode so the agent's next read sees it,
    // and close as "completed" so the wait surfaces the hand-off; otherwise just close.
    if (opts.startBuild && session) session.setSettings({ ...session.getSettings(), agentMode: "implementation" });
    quitNow(opts.startBuild ? "completed" : "window_closed");
  });

  // Self-update over npm: run the global install; the renderer then offers a restart.
  ipcMain.handle("app:apply-update", async () => {
    const r = await runCli(["update"]);
    try {
      return { ok: (JSON.parse(r.stdout.trim() || "{}") as { status?: string }).status === "updated" };
    } catch {
      return { ok: false };
    }
  });
  // Relaunch into the freshly-installed version (same doc/argv), bypassing the
  // quit dialog — the renderer persists any unsaved edits before calling this.
  ipcMain.handle("app:restart", () => {
    app.relaunch();
    app.exit(0);
  });

  // First-run onboarding flag, persisted at the user level (~/.inplan/state.json) so the
  // tour shows once per machine, not once per Electron-userData. `get` is synchronous so
  // the renderer can decide the very first render without a flash of the tour.
  ipcMain.on("onboarding:get", (e) => {
    e.returnValue = isOnboarded();
  });
  ipcMain.handle("onboarding:set", () => markOnboarded());

  // Cloud profile menu: identity + host-injected actions for the shared <ProfileMenu>.
  ipcMain.handle("profile:get", () => readProfile());
  ipcMain.handle("profile:set", async (_e, identity: { name: string; email?: string }) => {
    const name = (identity?.name ?? "").trim();
    if (!name) return;
    await runCli(["profile", "set", "--name", name, ...(identity.email && identity.email.trim() ? ["--email", identity.email.trim()] : [])]);
    win?.webContents.send("profile:changed");
  });
  ipcMain.handle("profile:action", async (_e, id: string) => {
    if (id === "collaborate") {
      await collaborateOnCloud();
    } else if (id === "signout") {
      await runCli(["logout"]);
      win?.webContents.send("profile:changed");
      void i18n.bootstrap(); // credentials cleared → re-resolve to English-only (drop the paid perk)
    } else if (id === "signin") {
      dialog.showMessageBoxSync(win!, {
        type: "info",
        message: "Sign in to inplan.ai",
        detail: "Run `inplan login` in your terminal to connect this app to your inplan.ai account, then reopen this menu.",
      });
      win?.webContents.send("profile:changed"); // refresh in case they just signed in
      void i18n.bootstrap(); // pick up the new session's locales/entitlement if they just logged in
    }
  });

  // Localization seam (paid perk): the renderer reads the snapshot + switches locale.
  ipcMain.handle("i18n:get", () => i18n.getSnapshot());
  ipcMain.handle("i18n:set-locale", (_e, code: string) => i18n.setLocale(code));
  // Live-collab connection info for the renderer ({hubUrl, desktopUrl} | null). Null ⇒ turn-only.
  ipcMain.handle("collab:hub", () => collabInfo());
}

void app.whenReady().then(async () => {
  // macOS shows the dock icon from the app bundle / running binary (not the window's
  // `icon`); set it explicitly so we don't show the default Electron icon when run via
  // the bundled `electron` dependency.
  if (process.platform === "darwin" && !appIcon.isEmpty()) app.dock?.setIcon(appIcon);
  handleCollabScheme(); // serve the verified collab bundle to the renderer (when one is loaded)
  const target = resolveTargetFile();
  if (target) {
    session = new Session(target);
    // Authoritative editor pid for the CLI's liveness/duplicate checks.
    session.logEditorPid(process.pid);
    navHistory.push(target);
    navIdx = 0;
    await startDesktopCollab(target, collabToken); // entitlement-gated; fail-soft to turn-only
    track("app_opened", session.getSettings().telemetry === true); // opt-in only
  }
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Cmd+Q (or any app.quit before a window-close was confirmed) routes through the
// same quit dialog: defer the quit and ask the renderer. Once confirmed — or if
// there's no window to ask — record the reason and let the quit proceed. logClose
// is idempotent, so an already-recorded "completed"/"window_closed" wins.
app.on("before-quit", (e) => {
  if (quitConfirmed || !win) {
    session?.logClose("window_closed"); // safety net for un-dialogged quits (a crash logs nothing)
    return;
  }
  // Renderer can't answer (loading/crashed/destroyed) → let the quit proceed, don't deadlock.
  if (!rendererCanConfirm()) {
    session?.logClose("window_closed");
    quitConfirmed = true;
    return;
  }
  e.preventDefault();
  win.webContents.send("app:confirm-quit");
  armQuitFallback();
});

app.on("window-all-closed", () => {
  app.quit();
});
