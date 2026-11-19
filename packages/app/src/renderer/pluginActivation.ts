// SPDX-License-Identifier: AGPL-3.0-or-later
//
// (Re)activating a runtime plugin for the current document, kept apart from the renderer's entry
// file so it can be tested: the entry runs on import, and the rule this module exists to hold is
// the kind that only a test keeps true.
//
// THE RULE: after `activate()` settles, the installed api describes THIS document and nothing
// else. Either the new activation's capabilities are installed, or the plain file-backed api is —
// never a previous document's. A binding left over from the document we navigated away from still
// answers "yes, bound" and still writes — to the wrong document.

import type { Api } from "@inplan/renderer";

/** What a plugin's renderer entry hands back for one document. */
export interface PluginExt {
  binding?: Api["binding"];
  commentStore?: Api["commentStore"];
  extraModes?: Api["extraModes"];
  sidePanels?: Api["sidePanels"];
  dispose: () => void;
}

export interface PluginRendererModule {
  activate: (session: string) => PluginExt | null;
}

export interface PluginActivatorDeps {
  /** The verified plugin's info for the CURRENT document, or null when there is none (not
   *  entitled, unverified, failed to start for this doc). */
  getInfo: () => Promise<{ session: string; rendererUrl: string } | null>;
  /** Import the verified renderer entry. Called at most once; `activate` is re-callable per doc. */
  importModule: (url: string) => Promise<PluginRendererModule>;
  /** The file-backed api the host exposes — the fallback, and the base the plugin's capabilities
   *  are merged onto. Undefined only if the host never exposed one. */
  baseApi: () => Api | undefined;
  /** Make `api` the one the editor uses. */
  install: (api: Api) => void;
  onError?: (err: unknown) => void;
}

export interface PluginActivator {
  /** (Re)activate against the current document. Never rejects. Resolves whether THIS call decided
   *  what is installed: false means a newer call overtook it and it changed nothing — so there is
   *  nothing new for the caller to mount an editor on yet. */
  activate: () => Promise<boolean>;
  /** Tear down the current activation (page unload). */
  dispose: () => void;
}

export function createPluginActivator(deps: PluginActivatorDeps): PluginActivator {
  /** The import, started at most once and shared by every call — overlapping activations must not
   *  each start their own. A failed import is forgotten so a later activation can try again. */
  let importing: Promise<PluginRendererModule> | null = null;
  const importOnce = (url: string): Promise<PluginRendererModule> =>
    (importing ??= deps.importModule(url).catch((err: unknown) => {
      importing = null;
      throw err;
    }));
  let current: PluginExt | null = null;
  /** Bumped by every `activate()`. A call that finds it moved while it was awaiting has been
   *  overtaken, and must touch nothing: the newer call owns the outcome. */
  let generation = 0;

  const disposeCurrent = (): void => {
    const ext = current;
    current = null;
    try {
      ext?.dispose();
    } catch {
      /* best-effort teardown of the previous document's binding */
    }
  };
  /** Swap to the file-backed api: tear the old activation down and INSTALL the base, in one
   *  synchronous step, so the previous document's capabilities are replaced rather than merely
   *  forgotten — and never left disposed-but-installed. */
  const fallBack = (): void => {
    disposeCurrent();
    const base = deps.baseApi();
    if (base) deps.install({ ...base });
  };

  return {
    dispose: disposeCurrent,
    async activate(): Promise<boolean> {
      const mine = ++generation;
      try {
        // Everything that awaits happens FIRST, with the previous activation still installed and
        // still live: the editor is mounted on it and keeps using it (typing, a programmatic
        // setText, a getText) until its replacement is ready. Tearing it down before these awaits
        // left the mounted editor holding a disposed binding for as long as they took.
        const info = await deps.getInfo();
        const mod = info ? await importOnce(info.rendererUrl) : null;
        if (mine !== generation) return false; // overtaken while awaiting — the newer call decides

        // From here to the end is synchronous: dispose → activate → install, with no gap in which
        // two activations are alive or none is installed.
        const base = deps.baseApi();
        const ext = info && base && mod ? (disposeCurrent(), mod.activate(info.session)) : null;
        if (!ext || !base) {
          fallBack();
          return true;
        }
        current = ext;
        deps.install({ ...base, binding: ext.binding, commentStore: ext.commentStore, extraModes: ext.extraModes, sidePanels: ext.sidePanels });
        return true;
      } catch (err) {
        // A plugin wiring failure must never block the editor — fall back to the file-backed api.
        deps.onError?.(err);
        if (mine !== generation) return false;
        fallBack();
        return true;
      }
    },
  };
}
