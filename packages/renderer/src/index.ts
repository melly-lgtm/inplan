// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of the inplan renderer. Hosts (the Electron app, the web edition)
// provide an `Api` implementation on `window.api`, then mount `<App />`.

export { App, AppRoot } from "./App";
export { createMemoryApi } from "./memoryApi";
export { createMemoryCommentStore, ***REMOVED***, reconcileComments, orderComments } from "./commentStore";
export type { CommentStore } from "./commentStore";
export { renderMarkdown } from "./markdown";
export { isInternalDocLink, resolveDocPath } from "./links";
export { ProfileMenu } from "./ProfileMenu";
export { AgentIndicator } from "./AgentIndicator";
// The English base catalog — hosts register it (and key their own locales off it).
export { EN as enCatalog } from "./i18n";
export type {
  Api,
  Cadence,
  Acceptance,
  SaveOptions,
  Settings,
  DocPayload,
  CollabBinding,
  AgentLocation,
  AgentPolicy,
  ProfileMenuItem,
  ProfileState,
  ProfileController,
  Catalog,
  I18nState,
  I18nController,
} from "./api";
