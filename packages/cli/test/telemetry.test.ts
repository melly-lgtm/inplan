// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in PostHog telemetry from the CLI (the editor-launch-failure signal). Asserts the privacy
// contract — anonymous event ($process_person_profile: false), throwaway distinct_id, event-name +
// coarse props only — plus opt-out / unconfigured / host-override / error-swallowing. KEY and
// ENDPOINT are read at module load, so each case resets modules and imports fresh after env setup.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "phc_cli_test_key";
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  fetchMock = vi.fn(() => Promise.resolve({ ok: true } as Response));
  vi.stubGlobal("fetch", fetchMock);
  process.env.INPLAN_POSTHOG_KEY = KEY;
  delete process.env.INPLAN_POSTHOG_HOST;
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.INPLAN_POSTHOG_KEY;
  delete process.env.INPLAN_POSTHOG_HOST;
});

describe("CLI telemetry (trackCli)", () => {
  it("sends an anonymous event with OS + reason when opted in", async () => {
    const { trackCli } = await import("../src/telemetry");
    trackCli("editor_launch_failed", true, { reason: "electron_unavailable" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://us.i.posthog.com/capture/");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.event).toBe("editor_launch_failed");
    expect(body.api_key).toBe(KEY);
    expect(body.properties.$process_person_profile).toBe(false);
    expect(body.properties.runtime).toBe("cli");
    expect(body.properties.reason).toBe("electron_unavailable");
    expect(typeof body.properties.$os).toBe("string");
    expect(typeof body.distinct_id).toBe("string");
  });

  it("sends nothing when telemetry is not opted in", async () => {
    const { trackCli } = await import("../src/telemetry");
    trackCli("editor_launch_failed", false, { reason: "electron_unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when no PostHog key is configured", async () => {
    delete process.env.INPLAN_POSTHOG_KEY;
    vi.resetModules();
    const { trackCli } = await import("../src/telemetry");
    trackCli("editor_launch_failed", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors a self-hosted host override", async () => {
    process.env.INPLAN_POSTHOG_HOST = "https://ph.inplan.ai/";
    vi.resetModules();
    const { trackCli } = await import("../src/telemetry");
    trackCli("editor_launch_failed", true);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://ph.inplan.ai/capture/");
  });

  it("swallows network errors (never throws)", async () => {
    const { trackCli } = await import("../src/telemetry");
    fetchMock.mockImplementation(() => Promise.reject(new Error("boom")));
    expect(() => trackCli("editor_launch_failed", true)).not.toThrow();
  });
});
