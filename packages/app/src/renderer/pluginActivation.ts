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
  /** (Re)activate against the current document. Never rejects. */
  activate: () => Promise<void>;
  /** Tear down the current activation (page unload). */
  dispose: () => void;
  /** Whether a plugin activation is currently installed. */
  readonly active: boolean;
}

export function createPluginActivator(deps: PluginActivatorDeps): PluginActivator {
  let mod: PluginRendererModule | null = null;
  let current: PluginExt | null = null;

  const disposeCurrent = (): void => {
    const ext = current;
    current = null;
    try {
      ext?.dispose();
    } catch {
      /* best-effort teardown of the previous document's binding */
    }
  };
  /** Fall back to the file-backed api — INSTALLING it, so whatever a previous document had
   *  installed is replaced rather than merely forgotten. */
  const installBase = (): void => {
    const base = deps.baseApi();
    if (base) deps.install({ ...base });
  };

  return {
    get active() {
      return current !== null;
    },
    dispose: disposeCurrent,
    async activate(): Promise<void> {
      // The previous document's activation ends here, whatever happens next. Disposing first (and
      // on EVERY path, including the ones that find no plugin for the new document) is what keeps
      // a stale binding from outliving its document.
      disposeCurrent();
      try {
        const info = await deps.getInfo();
        const base = deps.baseApi();
        if (!info || !base) {
          installBase();
          return;
        }
        if (!mod) mod = await deps.importModule(info.rendererUrl);
        const ext = mod.activate(info.session);
        if (!ext) {
          installBase();
          return;
        }
        current = ext;
        deps.install({ ...base, binding: ext.binding, commentStore: ext.commentStore, extraModes: ext.extraModes, sidePanels: ext.sidePanels });
      } catch (err) {
        // A plugin wiring failure must never block the editor — fall back to the file-backed api.
        deps.onError?.(err);
        disposeCurrent();
        installBase();
      }
    },
  };
}
