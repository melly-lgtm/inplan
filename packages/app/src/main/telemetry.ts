// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in, anonymous usage telemetry via PostHog. Sends NOTHING unless the user turns on
// "Share anonymous data" AND a PostHog project key is configured (INPLAN_POSTHOG_KEY).
// Events carry only an event name — never document content, paths, or any PII. Person
// profiles are disabled ($process_person_profile: false), and the distinct_id is a throwaway
// random value per event, so nothing identifies a user or links events across a session.
// The host is overridable (INPLAN_POSTHOG_HOST) so a self-hosted instance works too.
// Failures are swallowed: analytics never affects the app.

import { randomUUID } from "node:crypto";

const KEY = process.env.INPLAN_POSTHOG_KEY;
const ENDPOINT = `${(process.env.INPLAN_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "")}/capture/`;

/** Fire-and-forget an anonymous event — only when the user opted in and a key is set. */
export function track(event: string, enabled: boolean): void {
  if (!enabled || !KEY) return; // opted out (the default) or unconfigured → no network call
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "inplan-desktop" },
    body: JSON.stringify({
      api_key: KEY,
      event,
      distinct_id: randomUUID(), // throwaway: no stable identifier, no cross-event linkage
      properties: { $process_person_profile: false }, // anonymous event — PostHog creates no person profile
    }),
  }).catch(() => {
    /* analytics must never surface an error to the user */
  });
}
