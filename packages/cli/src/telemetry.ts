// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in, anonymous CLI telemetry via PostHog — a sibling of the desktop app's
// (packages/app/src/main/telemetry.ts), for signals only the CLI can emit: chiefly the editor
// failing to launch, where no app process ever starts so the app can't report it. Sends NOTHING
// unless the user opted in (~/.inplan/settings.json `telemetry`) AND a key is configured. Events
// carry only an event name + coarse, non-PII props (enums/booleans) — never paths or content.
// Anonymous ($process_person_profile: false, throwaway distinct_id). The key is baked into the
// published CLI bundle at build time (tsup define); INPLAN_POSTHOG_HOST overrides for self-hosting.
// Fire-and-forget; failures are swallowed so analytics never affects the CLI.

import { randomUUID } from "node:crypto";

const KEY = process.env.INPLAN_POSTHOG_KEY;
const ENDPOINT = `${(process.env.INPLAN_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/$/, "")}/capture/`;

/** PostHog's recognized OS label for the current platform (so its OS breakdown populates). */
function osName(): string {
  switch (process.platform) {
    case "darwin":
      return "Mac OS X";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return process.platform;
  }
}

/** Fire-and-forget an anonymous CLI event — only when the user opted in and a key is set. */
export function trackCli(
  event: string,
  enabled: boolean,
  props?: Record<string, string | number | boolean | undefined>,
): void {
  if (!enabled || !KEY) return; // opted out (the default) or unconfigured → no network call
  void fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": "inplan-cli" },
    body: JSON.stringify({
      api_key: KEY,
      event,
      distinct_id: randomUUID(), // throwaway: no stable identifier, no cross-event linkage
      properties: {
        $process_person_profile: false, // anonymous event — PostHog creates no person profile
        $os: osName(),
        runtime: "cli",
        node_version: process.versions.node,
        ...props, // per-event, non-PII (undefined dropped by JSON.stringify)
      },
    }),
  }).catch(() => {
    /* analytics must never surface an error to the user */
  });
}
