// SPDX-License-Identifier: AGPL-3.0-or-later
//
// i18n seam for the editor. The English catalog below is the source of truth for keys
// and default text; `t(key)` returns the active-locale string, falling back to English,
// then to the key itself. The active locale + any extra catalogs come from the host via
// `window.api.i18n` (the web wires it for everyone; the desktop only for paid users), so
// with no host i18n the editor simply runs in this built-in English.

import { useCallback, useEffect, useRef, useState } from "react";
import type { Catalog, I18nState, I18nController } from "./api";

/** English base catalog — the source of truth for keys + default text. Values may use
 *  `{name}` placeholders. Keep keys stable; translators key off these. */
export const EN: Catalog = {
  // top bar — controls
  "topbar.turn": "Turn",
  "topbar.instant": "Instant",
  "topbar.back": "Back",
  "topbar.forward": "Forward",
  "topbar.prevDoc": "Back to previous document",
  "topbar.nextDoc": "Forward to next document",
  "topbar.settings": "Settings",
  "topbar.zoomOut": "Zoom out",
  "topbar.zoomIn": "Zoom in",
  "topbar.resetZoom": "Reset zoom",
  "topbar.panes": "{n} pane",
  "topbar.panesPlural": "{n} panes",
  "topbar.find": "Find & replace",
  "topbar.addComment": "Comment on Text",
  "topbar.addDocComment": "Comment on Doc",
  "topbar.addCommentTitle": "Comment on the selected text",
  "topbar.addDocCommentTitle": "Comment on the whole document",
  "ctx.createDoc": "Create Doc",
  "ctx.moveToDoc": "Move Blocks to New Doc",
  "newdoc.createTitle": "Create new document",
  "newdoc.moveTitle": "Move blocks to a new document",
  "newdoc.titleLabel": "Title",
  "newdoc.location": "File location",
  "newdoc.browse": "Browse…",
  "newdoc.create": "Create",
  "newdoc.move": "Move",
  "newdoc.exists": "That file already exists.",
  "newdoc.appendExisting": "Append blocks to the existing doc",
  "newdoc.willLink": "It will be linked, not created.",
  "newdoc.append": "Append",
  "newdoc.linkExisting": "Link to it",
  "newdoc.failed": "Couldn’t create the document.",
  "newdoc.cantMove": "Can’t move this selection — it crosses formatting or a comment’s edge.",
  "topbar.cantOverlap": "Comments can't overlap",
  "topbar.cantWhitespace": "Comments can't be added to white space",
  "topbar.cantSpanBlocks": "Comments can't span multiple blocks",
  "topbar.cantSpanTable": "Comments can't span table cells",
  "topbar.cantRendered": "Comments can't be anchored to this text",
  "topbar.save": "Save",
  "topbar.saveUnsaved": "Save — unsaved changes",
  "topbar.finishTurn": "Finish turn",
  "topbar.finishTurnTitle": "Finish turn — hand off to the agent",
  "quit.title": "Do you want to quit?",
  "quit.save": "Save {file}",
  "quit.startBuild": "Switch agent to build mode",
  "quit.thisDoc": "this document",
  "quit.quit": "Quit",
  "quit.cancel": "Cancel",
  "topbar.noAgent": "Connect an agent (open this doc with a local or cloud agent) to use this",
  // settings menu
  "settings.title": "Settings",
  "settings.telemetry": "Share anonymous data",
  "settings.telemetryHint": "Off by default. Sends only anonymous, aggregate usage events — never your documents.",
  "settings.agentMode": "Agent mode",
  "settings.keepPlanning": "Keep agent in planning",
  "settings.autoAcceptChanges": "Auto-accept agent's changes",
  "settings.modePlanning": "Planning",
  "settings.modeBuild": "Build",
  "settings.agentChanges": "Agent changes",
  "settings.autoAccept": "Auto-accept",
  "settings.review": "Review",
  "settings.autoResolve": "Auto-resolve comments",
  "settings.autoResolveHint": "When off, the agent replies that the thread can be resolved and leaves it for you.",
  "settings.replayTutorial": "Replay tutorial",
  // first-run onboarding (guided tour over a throwaway sample plan)
  "onboarding.skip": "Skip tutorial",
  "onboarding.next": "Next",
  "onboarding.done": "Open my plan",
  "onboarding.progress": "{n} of {total}",
  "onboarding.actionDone": "Nice — done!",
  "onboarding.welcome.title": "Welcome to inplan 👋",
  "onboarding.welcome.body": "A quick tour on a sample plan — nothing here is saved. You and your coding agent plan together by leaving comments on the document.",
  "onboarding.settings.title": "Choose how the agent applies edits",
  "onboarding.settings.body": "This is the Settings menu. “Agent changes” chooses Review — the agent parks its edits for you to approve (the default) — or Auto-accept, which applies them live. Below it, choose whether the agent auto-resolves a comment thread after addressing it. Change these anytime.",
  "onboarding.inline.title": "Comment on a line",
  "onboarding.inline.body": "Select some text in the plan, then press {shortcut} or right-click → Comment on Text. Try it now.",
  "onboarding.doc.title": "Comment on the whole document",
  "onboarding.doc.body": "With nothing selected, the menu reads “Comment on Doc” and posts a note about the whole plan. Try adding one.",
  "onboarding.answer.title": "Answer the agent",
  "onboarding.answer.body": "The agent asked a question in the comments. Pick an option and click Answer.",
  "onboarding.finish.title": "You're all set 🎉",
  "onboarding.finish.body": "That's the loop: comment, answer, and let the agent revise. Ready to open your plan?",
  // pane tabs + splitter
  "tabs.comments": "Comments",
  "tabs.source": "Source",
  "splitter.resize": "Drag to resize",
  // profile menu
  "profile.account": "Account menu",
  "profile.notSignedIn": "Not signed in",
  "profile.language": "Language",
  "app.loading": "Loading…",
  // choice-answer chips
  "question.other": "Other…",
  "question.answer": "Answer",
  "question.change": "Change answer",
  "question.showMore": "Show {n} more",
  "question.showLess": "Show less",
  // transient status messages
  "msg.proposedReview": "agent proposed changes — review below",
  "msg.agentUpdated": "agent updated the document",
  "msg.agentTook": "agent took its turn — your move",
  "msg.nothingUndo": "nothing to undo",
  "msg.undid": "undid last change",
  "msg.nothingRedo": "nothing to redo",
  "msg.redid": "redid change",
  "msg.tookBack": "you took back control — the agent didn't hand it back",
  "msg.autosaving": "auto-saving…",
  "msg.autosaved": "autosaved (backup)",
  "msg.turnFinished": "turn finished — waiting for agent",
  "msg.cantAnchor": "Comments can't be anchored to this selection",
  // status bar
  "status.ready": "ready",
  "status.thinking": "Agent is thinking",
  "status.thinkingTitle": "Agent is working. Hover to take back control if it's not responding.",
  "status.takeBack": "not responding? take back control",
  "status.takeBackTitle": "The agent hasn't handed control back. Reclaim the turn and keep editing.",
  "status.mode": "mode",
  "status.agentMessages": "Agent messages",
  "status.unsaved": "unsaved",
  // composer popover
  "composer.on": "on “{target}”",
  "composer.docLevel": "document-level comment",
  "composer.dragToMove": "drag to move",
  "composer.placeholder": "Add a comment…  ({mod}+Enter to submit)",
  "composer.comment": "Comment",
  "composer.cancel": "cancel",
  // agent connection indicator
  "agent.connectCloud": "Connect a cloud agent",
  "agent.waitLocal": "Wait for my local agent",
  "agent.dontConnect": "Don't auto-connect",
  "agent.remote": "remote",
  "agent.local": "local",
  "agent.disconnected": "disconnected",
  "agent.title": "Agent: {label}",
  "agent.connectionLabel": "Agent connection — {label}",
  "agent.whereCloud": "cloud",
  "agent.whereLocal": "your machine",
  "agent.detail": "Agent · {where}",
  "agent.none": "No agent connected",
  "agent.plan": "Plan {pct}%",
  "agent.overIncluded": "— over included",
  "agent.over": "(over)",
  "agent.connection": "Agent connection",
  "agent.localCmdHint": "Paste this to your coding agent:",
  "agent.localCmdBody": "Collaborate with me on my inplan plan — run: {cmd}  (install the inplan CLI and run inplan login first if needed).",
  "agent.copy": "Copy",
  "agent.copied": "Copied",
  // comment rail
  "rail.comments": "Comments",
  "rail.emptyHint": "No comments. Select text and use “+ {action}”.",
  "rail.prevThread": "Previous Thread",
  "rail.nextThread": "Next Thread",
  "rail.showResolved": "Show resolved ({resolved}) & orphaned ({orphaned}) comments",
  "rail.showResolvedOnly": "Show resolved ({resolved}) comments",
  "rail.showOrphanedOnly": "Show orphaned ({orphaned}) comments",
  // preview right-click context menu
  "menu.findText": "Find Text",
  "menu.copy": "Copy",
  "menu.selectLine": "Select Line",
  "menu.selectAll": "Select All",
  "rail.resolveThread": "Resolve thread",
  "rail.reopenThread": "Reopen thread",
  "rail.agentSuggestedResolve": "Agent suggested to resolve",
  "rail.reply": "Reply",
  // banners
  "banner.agentReady": "The agent thinks the plan is ready.",
  "banner.dismiss": "dismiss",
  "banner.newBuild": "🔄 A new build is ready —",
  "banner.reloadingIn": "reloading in {n}s",
  "banner.reloadNow": "Reload now",
  "banner.cancel": "Cancel",
  "banner.updated": "✅ Updated to",
  "banner.restartToApply": "— restart inplan to apply.",
  "banner.restart": "Restart",
  "banner.newVersion": "⬆️ A new version is available",
  "banner.updateFailed": "Update failed — try again.",
  "banner.updating": "Updating…",
  "banner.updateNow": "Update now",
  "banner.later": "Later",
  "banner.proposalPending": "The agent proposed changes awaiting your review.",
  "banner.review": "Review",
  "banner.proposedChanges": "Agent proposed changes",
  "banner.changesShown": "— {n} change shown inline below",
  "banner.changesShownPlural": "— {n} changes shown inline below",
  "banner.scrollToNext": "Scroll to the next change",
  "banner.reviewNext": "Review next",
  "banner.acceptAll": "Accept all",
  "banner.rejectAll": "Reject all",
  "banner.apply": "Apply",
  "banner.laterLower": "later",
  "banner.locked": "— locked while the agent works; finish handing back to act",
  // find / replace bar
  "find.toggleReplace": "toggle replace",
  "find.replace": "Replace",
  "find.findPlaceholder": "Find…",
  "find.replacePlaceholder": "Replace…",
  "find.searchPreview": "search the rendered preview",
  "find.preview": "preview",
  "find.searchEditor": "search the source (editor) pane",
  "find.editor": "editor",
  "find.comments": "comments",
  "find.caseInsensitive": "case-insensitive",
  "find.replacePrev": "Replace Prev",
  "find.replaceNext": "Replace Next",
  "find.replaceAll": "Replace All",
  "find.findPrev": "Find Prev",
  "find.findNext": "Find Next",
  "find.close": "close",
  // comment thread
  "thread.orphaned": "⚠ anchor removed (orphaned)",
  "thread.anchorMissing": "(anchor missing)",
  "thread.replyPlaceholder": "Reply…",
  "thread.comment": "Comment",
  "thread.cancel": "Cancel",
  "thread.save": "Save",
  "thread.more": "More",
  "thread.modify": "Modify",
  "thread.delete": "Delete",
};

/** The default state used when no host i18n is wired (the open core, tests). */
const FALLBACK: I18nState = {
  locale: "en",
  catalogs: { en: EN },
  available: [{ code: "en", label: "English" }],
  setLocale: () => {},
};

const controller = (): I18nController | null => (typeof window !== "undefined" ? (window.api?.i18n ?? null) : null);

/** Resolve a key against a state: active locale → English → the key. Interpolates `{vars}`. */
export function translate(state: I18nState, key: string, vars?: Record<string, string | number>): string {
  const raw = state.catalogs[state.locale]?.[key] ?? state.catalogs.en?.[key] ?? EN[key] ?? key;
  return vars ? raw.replace(/\{(\w+)\}/g, (_m, k: string) => String(vars[k] ?? `{${k}}`)) : raw;
}

/**
 * Subscribe to the host's i18n controller using the state-push pattern (useState +
 * subscribe), NOT useSyncExternalStore: the controller is proxied across Electron's
 * contextBridge, where get() does not return a referentially-stable snapshot — the same
 * reason `useProfile` avoids useSyncExternalStore. We store whatever get()/subscribe
 * hands us, so an unstable snapshot can't trigger a render loop. Falls back to English.
 */
function useI18nState(): I18nState {
  const [state, setState] = useState<I18nState>(() => {
    const c = controller();
    return c ? c.get() : FALLBACK;
  });
  useEffect(() => {
    const c = controller();
    if (!c) return;
    setState(c.get());
    return c.subscribe(setState);
  }, []);
  return state;
}

/** Hook: a `t(key, vars?)` bound to the active locale — for components that only need
 *  to translate (one subscription). Components that also need the locale list (the
 *  picker) use {@link useI18n} + {@link translate} to avoid a second subscription.
 *
 *  The returned function is referentially STABLE across renders but always resolves
 *  against the latest locale via a ref: so a `t` captured inside `useCallback(fn, [])`
 *  / `useEffect(fn, [])` (e.g. App's undo/redo/finish-turn status messages) keeps
 *  translating in the current language after a locale switch instead of going stale. */
export function useT(): (key: string, vars?: Record<string, string | number>) => string {
  const state = useI18nState();
  const ref = useRef(state);
  ref.current = state; // refreshed every render so the stable callback sees the latest locale
  return useCallback((key, vars) => translate(ref.current, key, vars), []);
}

/** Hook: the current i18n state (e.g. for the language picker). */
export function useI18n(): I18nState {
  return useI18nState();
}
