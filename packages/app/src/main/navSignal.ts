// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What to tell the renderer after an in-window navigation swapped the document.
 *
 * `reactivate` makes it re-run plugin activation and re-mount the editor; `navigated` just hands
 * it the new document. The renderer must re-run activation whenever its installed capabilities
 * could be stale — which is not only when the NEW document has a plugin. If the renderer is
 * holding a previous document's binding and this document has none (the plugin failed to start
 * for it), sending only `navigated` loads the new document into an editor whose every
 * programmatic body write goes to the OLD document's shared state.
 */
export function navigationSignal(rendererHasPlugin: boolean, hasPlugin: boolean): "reactivate" | "navigated" {
  return rendererHasPlugin || hasPlugin ? "reactivate" : "navigated";
}

/**
 * Remembers whether the RENDERER may be holding a plugin activation — i.e. what it was last told
 * to activate against — which is the fact `navigationSignal` needs.
 *
 * Main's own plugin state is the wrong thing to ask. A navigation stops the running plugin before
 * it starts the next, so a second navigation arriving mid-refresh reads "no plugin" while the
 * renderer is still bound to the first document; and the first refresh, overtaken, sends nothing.
 * Only a signal that was actually SENT changes what the renderer holds.
 */
export interface NavTracker {
  /** The signal to send for a document whose plugin state is `hasPlugin`. Pure: sending is the caller's. */
  signalFor: (hasPlugin: boolean) => "reactivate" | "navigated";
  /** Record that the renderer was (re)activated against a document with/without a plugin. */
  rendererActivated: (hasPlugin: boolean) => void;
}

export function createNavTracker(): NavTracker {
  let rendererHasPlugin = false;
  return {
    signalFor: (hasPlugin) => navigationSignal(rendererHasPlugin, hasPlugin),
    rendererActivated: (hasPlugin) => {
      rendererHasPlugin = hasPlugin;
    },
  };
}

/**
 * Runs async jobs strictly one after another, in the order they were queued.
 *
 * A plugin refresh is stop-then-start, two awaits on shared state. Run concurrently, a second
 * refresh's stop finds nothing to stop (the first has not started its plugin yet), and whichever
 * start resolves last wins — which need not be the newest document. A job that throws does not
 * stall the ones behind it, and is reported to `onError` rather than lost: the queue is run
 * un-awaited, so nothing else would ever hear of it.
 */
export function createSerialQueue(onError: (err: unknown) => void = () => {}): { run: (job: () => Promise<void>) => Promise<void> } {
  let tail: Promise<void> = Promise.resolve();
  return {
    run: (job) => {
      tail = tail.then(job).catch(onError);
      return tail;
    },
  };
}
