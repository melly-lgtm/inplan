// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The platform's primary shortcut modifier, for display in hints/tooltips: the ⌘
 * symbol on macOS, "Ctrl" everywhere else. Resolved once from the user agent so UI
 * copy can show a single key (e.g. "{mod}+Enter") instead of "Cmd/Ctrl".
 */
const ua = (typeof navigator !== "undefined" && (navigator.userAgent || navigator.platform)) || "";
export const MOD_KEY: string = /mac/i.test(ua) ? "⌘" : "Ctrl";
