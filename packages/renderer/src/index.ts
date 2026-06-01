// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of the inplan renderer. Hosts (the Electron app, the web edition)
// provide an `Api` implementation on `window.api`, then mount `<App />`.

export { App } from "./App";
export { createMemoryApi } from "./memoryApi";
export { renderMarkdown } from "./markdown";
export { isInternalDocLink, resolveDocPath } from "./links";
export type { Api, Cadence, Acceptance, SaveOptions, Settings, DocPayload } from "./api";
