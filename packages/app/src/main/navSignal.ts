// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * What to tell the renderer after an in-window navigation swapped the document.
 *
 * `reactivate` makes it re-run plugin activation and re-mount the editor; `navigated` just hands
 * it the new document. The renderer must re-run activation whenever its installed capabilities
 * could be stale — which is not only when the NEW document has a plugin. If the previous document
 * had one and this one does not (the plugin failed to start for it), the renderer is still holding
 * the previous document's binding: sending only `navigated` loads the new document into an editor
 * whose every programmatic body write goes to the OLD document's shared state.
 */
export function navigationSignal(hadPlugin: boolean, hasPlugin: boolean): "reactivate" | "navigated" {
  return hadPlugin || hasPlugin ? "reactivate" : "navigated";
}
