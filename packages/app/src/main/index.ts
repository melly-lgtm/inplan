// SPDX-License-Identifier: AGPL-3.0-or-later

import { app, BrowserWindow, dialog, ipcMain, nativeImage, shell } from "electron";
import { APP_ICON_DATA_URL } from "./appIcon";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Acceptance, Cadence, SaveOptions, Settings } from "@inplan/renderer";
import { Session } from "./session";
import { createI18nController } from "./i18nController";

const __dirname = dirname(fileURLToPath(import.meta.url));

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

/** The current cloud profile: who is signed in + the actions to offer. */
async function readProfile(): Promise<ProfileSnapshot> {
  ensureCloudProbe();
  // Cloud kill switch: while the link isn't enabled (server flag off, or unreachable),
  // show no cloud chrome at all — regardless of any existing CLI session — so nothing
  // funnels the user toward the cloud.
  if (!cloudLinkEnabled) return { user: null, agentLocation: null, actions: [] };
  const r = await runCli(["whoami"]);
  let who: { signedIn?: boolean; email?: string } = {};
  try {
    who = JSON.parse(r.stdout.trim() || "{}");
  } catch {
    /* treat unparseable as signed out */
  }
  if (who.signedIn) {
    return {
      user: { name: who.email ?? "Signed in", ...(who.email ? { email: who.email } : {}) },
      agentLocation: null, // desktop has no live presence room; the web derives it from awareness
      actions: [
        { id: "collaborate", label: "Collaborate on Cloud", primary: true },
        { id: "signout", label: "Sign out", danger: true },
      ],
    };
  }
  // Signed out but link enabled: offer cloud sign-in.
  return { user: null, agentLocation: null, actions: [{ id: "signin", label: "Sign in…" }] };
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
  session.logClose("window_closed");
  app.quit();
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
  win.webContents.send("doc:navigated", session.load());
  return true;
}

/** The inplan mark (same as inplan.ai), for the window + dock icon. */
const appIcon = nativeImage.createFromDataURL(APP_ICON_DATA_URL);

function createWindow(): void {
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
    void checkForUpdate();
    void probeCloud();
    void i18n.bootstrap(); // load cached locale + refresh catalogs from the cloud (paid perk)
  });

  stopWatching = watchSession();

  // Prompt to Save / Don't Save / Cancel when closing with unsaved edits.
  let forceClose = false;
  win.on("close", (e) => {
    if (forceClose || !session?.hasUnsaved) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win!, {
      type: "question",
      buttons: ["Save", "Don't Save", "Cancel"],
      defaultId: 0,
      cancelId: 2,
      message: "Save changes before closing?",
      detail: "Your edits this turn aren't saved to the plan yet.",
    });
    if (choice === 2) return; // Cancel — keep the window open
    if (choice === 0) {
      session.complete(session.pending);
      session.logClose("completed");
    } else {
      session.logClose("window_closed");
    }
    forceClose = true;
    win!.close();
  });

  win.on("closed", () => {
    stopWatching?.();
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
  ipcMain.handle("window:close", () => win?.close());
  ipcMain.handle("proposal:get", () => session?.pendingProposal() ?? null);
  ipcMain.handle("proposal:clear", () => {
    session?.clearProposal();
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
  ipcMain.handle("doc:complete", (_e, content: string) => {
    session?.complete(content);
    session?.logClose("completed");
    app.quit();
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

  // Cloud profile menu: identity + host-injected actions for the shared <ProfileMenu>.
  ipcMain.handle("profile:get", () => readProfile());
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
}

void app.whenReady().then(() => {
  // macOS shows the dock icon from the app bundle / running binary (not the window's
  // `icon`); set it explicitly so we don't show the default Electron icon when run via
  // the bundled `electron` dependency.
  if (process.platform === "darwin" && !appIcon.isEmpty()) app.dock?.setIcon(appIcon);
  const target = resolveTargetFile();
  if (target) {
    session = new Session(target);
    // Authoritative editor pid for the CLI's liveness/duplicate checks.
    session.logEditorPid(process.pid);
    navHistory.push(target);
    navIdx = 0;
  }
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Any quit path (window close, Cmd+Q) records a reason — unless Complete & quit
// already logged "completed". A crash logs nothing, so the agent's wait reports it.
app.on("before-quit", () => {
  session?.logClose("window_closed");
});

app.on("window-all-closed", () => {
  app.quit();
});
