// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in, anonymous usage telemetry via Plausible. Sends NOTHING unless the user
// turns on "Share anonymous usage data" AND a Plausible domain is configured
// (INPLAN_PLAUSIBLE_DOMAIN, e.g. "app.inplan.ai"). Events carry only an event name —
// never document content, paths, or any PII. The endpoint is overridable so the
// domain owner can self-host. Failures are swallowed: analytics never affects the app.

const DOMAIN = process.env.INPLAN_PLAUSIBLE_DOMAIN;
const ENDPOINT = `${(process.env.INPLAN_PLAUSIBLE_URL || "https://plausible.io").replace(/\/$/, "")}/api/event`;

/** Fire-and-forget an anonymous event — only when the user opted in and a domain is set. */
export function track(event: string, enabled: boolean): void {
  if (!enabled || !DOMAIN) return; // opted out (the default) or unconfigured → no network call
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "inplan-desktop" },
    body: JSON.stringify({ domain: DOMAIN, name: event, url: `app://inplan/${event}` }),
  }).catch(() => {
    /* analytics must never surface an error to the user */
  });
}
