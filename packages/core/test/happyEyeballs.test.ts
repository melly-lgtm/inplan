// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The per-address connect budget (happyEyeballs.ts). Node's 250 ms default aborts a healthy but
// distant IPv4 connect as soon as a black-holed IPv6 route exists alongside it, which is how a
// reachable hub came to report `fetch failed`. These tests pin the floor semantics: raise a
// too-small budget, never lower one an operator deliberately set, and never throw on a runtime
// that lacks the knob.

import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CONNECT_ATTEMPT_TIMEOUT_MS, widenConnectAttemptBudget } from "../src/happyEyeballs";

afterEach(() => {
  vi.restoreAllMocks();
});

/** Stand in for the pair of module-level knobs, returning what `set` was last given. */
function stubBudget(initial: number | undefined): { set: ReturnType<typeof vi.fn> } {
  let current = initial;
  const set = vi.fn((ms: number) => {
    current = ms;
  });
  vi.spyOn(net, "getDefaultAutoSelectFamilyAttemptTimeout").mockImplementation(() => current as number);
  vi.spyOn(net, "setDefaultAutoSelectFamilyAttemptTimeout").mockImplementation(set as (ms: number) => void);
  return { set };
}

describe("widenConnectAttemptBudget", () => {
  it("raises Node's 250 ms default to the widened budget", () => {
    const { set } = stubBudget(250);
    expect(widenConnectAttemptBudget()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
    expect(set).toHaveBeenCalledWith(CONNECT_ATTEMPT_TIMEOUT_MS);
  });

  it("is a floor, not an assignment — a longer operator-set budget survives", () => {
    const { set } = stubBudget(10_000);
    expect(widenConnectAttemptBudget()).toBe(10_000);
    expect(set).not.toHaveBeenCalled();
  });

  it("widens to an explicit budget when asked", () => {
    const { set } = stubBudget(250);
    expect(widenConnectAttemptBudget(5_000)).toBe(5_000);
    expect(set).toHaveBeenCalledWith(5_000);
  });

  it("treats a non-finite current budget as un-set and widens it", () => {
    const { set } = stubBudget(Number.NaN);
    expect(widenConnectAttemptBudget()).toBe(CONNECT_ATTEMPT_TIMEOUT_MS);
    expect(set).toHaveBeenCalledWith(CONNECT_ATTEMPT_TIMEOUT_MS);
  });

  it("reports null — and does not throw — on a runtime without the knob", () => {
    // Node < 18.18 simply doesn't define it; an absent property is how that actually presents.
    const saved = net.getDefaultAutoSelectFamilyAttemptTimeout;
    (net as { getDefaultAutoSelectFamilyAttemptTimeout?: unknown }).getDefaultAutoSelectFamilyAttemptTimeout = undefined;
    try {
      expect(widenConnectAttemptBudget()).toBeNull();
    } finally {
      net.getDefaultAutoSelectFamilyAttemptTimeout = saved;
    }
  });

  it("keeps the CLI starting when Node rejects the value", () => {
    const { set } = stubBudget(250);
    set.mockImplementation(() => {
      throw new RangeError("out of range");
    });
    expect(widenConnectAttemptBudget()).toBe(250);
  });

  it("defaults to a budget that clears a trans-Pacific connect", () => {
    // The failure this exists for measured 215–405 ms from Seoul to the SJC hub; a budget at or
    // under Node's 250 ms default would not have fixed it.
    expect(CONNECT_ATTEMPT_TIMEOUT_MS).toBeGreaterThan(500);
  });
});
