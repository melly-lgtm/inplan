// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Opt-in PostHog telemetry: a fire-and-forget anonymous event, sent ONLY when the user
// opted in AND a project key is configured. Asserts the privacy contract — anonymous event
// ($process_person_profile: false), a throwaway distinct_id, event-name only — plus the
// opt-out / unconfigured / self-hosted / error-swallowing paths. KEY and ENDPOINT are read
// at module load, so each case resets modules and imports fresh after setting the env.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "phc_test_key";
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

describe("PostHog telemetry", () => {
  it("sends an anonymous event to /capture/ when opted in", async () => {
    const { track } = await import("../src/main/telemetry");
    track("app_opened", true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://us.i.posthog.com/capture/");
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.api_key).toBe(KEY);
    expect(body.event).toBe("app_opened");
    expect(body.properties.$process_person_profile).toBe(false); // no person profile = anonymous
    expect(typeof body.distinct_id).toBe("string");
    expect(body.distinct_id.length).toBeGreaterThan(0);
  });

  it("includes aggregate OS + runtime properties (no PII)", async () => {
    const { track } = await import("../src/main/telemetry");
    track("app_opened", true);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    const expectedOs = { darwin: "Mac OS X", win32: "Windows", linux: "Linux" }[process.platform] ?? process.platform;
    expect(body.properties.$os).toBe(expectedOs);
    expect(body.properties.$browser).toBe("Electron");
  });

  it("uses a fresh throwaway distinct_id each call (no cross-event linkage)", async () => {
    const { track } = await import("../src/main/telemetry");
    track("a", true);
    track("b", true);
    const id0 = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string).distinct_id;
    const id1 = JSON.parse((fetchMock.mock.calls[1]![1] as RequestInit).body as string).distinct_id;
    expect(id0).not.toBe(id1);
  });

  it("merges per-event props over the base properties", async () => {
    const { track } = await import("../src/main/telemetry");
    track("session_closed", true, { reason: "completed", startBuild: true });
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.event).toBe("session_closed");
    expect(body.properties.reason).toBe("completed");
    expect(body.properties.startBuild).toBe(true);
    expect(body.properties.$process_person_profile).toBe(false); // base props still present
    expect(body.properties.$browser).toBe("Electron");
  });

  it("never lets per-event props override anonymity ($process_person_profile stays false)", async () => {
    const { track } = await import("../src/main/telemetry");
    // A caller (mistakenly or maliciously) tries to flip on person processing.
    track("app_opened", true, { $process_person_profile: true } as never);
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.properties.$process_person_profile).toBe(false); // pinned — anonymity holds
  });

  it("sends nothing when the user has not opted in", async () => {
    const { track } = await import("../src/main/telemetry");
    track("app_opened", false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends nothing when no PostHog key is configured", async () => {
    delete process.env.INPLAN_POSTHOG_KEY;
    vi.resetModules();
    const { track } = await import("../src/main/telemetry");
    track("app_opened", true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("honors a self-hosted host override (trailing slash trimmed)", async () => {
    process.env.INPLAN_POSTHOG_HOST = "https://ph.inplan.ai/";
    vi.resetModules();
    const { track } = await import("../src/main/telemetry");
    track("app_opened", true);
    expect(fetchMock.mock.calls[0]![0]).toBe("https://ph.inplan.ai/capture/");
  });

  it("swallows network errors (never throws)", async () => {
    const { track } = await import("../src/main/telemetry");
    // Reject lazily inside the mock so track's .catch attaches in the same tick (no transient
    // unhandled rejection); track must neither throw nor surface the error.
    fetchMock.mockImplementation(() => Promise.reject(new Error("boom")));
    expect(() => track("app_opened", true)).not.toThrow();
  });
});
