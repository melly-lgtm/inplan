// SPDX-License-Identifier: AGPL-3.0-or-later

import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import type { Acceptance, Cadence, SaveOptions, Settings } from "../shared/api";
import { Session } from "./session";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Log main-process errors to stderr instead of Electron's default GUI error dialog.
process.on("uncaughtException", (err) => {
  process.stderr.write(`[agent-planner] uncaught exception: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`[agent-planner] unhandled rejection: ${String(reason)}\n`);
});

/** The plan file to open is the first non-flag CLI argument. */
function resolveTargetFile(): string | null {
  const args = process.argv.slice(app.isPackaged ? 1 : 2);
  const candidate = args.find((a) => !a.startsWith("-"));
  if (!candidate) return null;
  const abs = resolve(candidate);
  return existsSync(abs) ? abs : null;
}

let session: Session | null = null;
let win: BrowserWindow | null = null;
let stopWatching: (() => void) | null = null;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: "agent-planner",
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

  if (session) {
    stopWatching = session.watch({
      onExternalChange: (content) => win?.webContents.send("doc:external-change", { path: session!.paths.file, content }),
      onAgentDone: () => win?.webContents.send("agent:done"),
      onAgentActive: () => win?.webContents.send("agent:active"),
    });
  }

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
  ipcMain.handle("doc:complete", (_e, content: string) => {
    session?.complete(content);
    session?.logClose("completed");
    app.quit();
  });
}

void app.whenReady().then(() => {
  const target = resolveTargetFile();
  if (target) {
    session = new Session(target);
    // Authoritative editor pid for the CLI's liveness/duplicate checks.
    session.logEditorPid(process.pid);
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
