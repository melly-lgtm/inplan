// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Public surface of the inplan renderer. Hosts (the Electron app, the web edition)
// provide an `Api` implementation on `window.api`, then mount `<App />`.

export { App, AppRoot } from "./App";
// Hosts that augment the base api (the desktop merges the verified live-collab binding at startup)
// install it here, since `window.api` is a frozen contextBridge property and can't be reassigned.
export { setHostApi } from "./api";
export { createMemoryApi } from "./memoryApi";
export { createMemoryCommentStore, reconcileComments, orderComments } from "./commentStore";
export type { CommentStore } from "./commentStore";
export { TURN_MODE, resolveMode } from "./mode";
export type { ModeDescriptor, ModePolicy } from "./mode";
export { renderMarkdown } from "./markdown";
export { isInternalDocLink, resolveDocPath } from "./links";
// Line-diff utilities — pure (no DOM/state), reused by hosts to render version-vs-current diffs.
export { lineSegments, isChange } from "./textdiff";
export type { DiffSegment } from "./textdiff";
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
  EditorBinding,
  SidePanelSpec,
  SidePanelContext,
  AgentLocation,
  AgentPolicy,
  ProfileMenuItem,
  ProfileState,
  ProfileController,
  Catalog,
  I18nState,
  I18nController,
} from "./api";
