// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Node's Happy Eyeballs budget, widened for a CLI whose hub is one distant machine.
//
// Since Node 20, `net.connect` (and therefore `fetch`, which rides undici on top of it) races a
// hostname's IPv4 and IPv6 addresses per RFC 8305, giving the FIRST address only
// `autoSelectFamilyAttemptTimeout` — 250 ms by default — before starting the second. That default
// assumes the two families fail independently. They don't: when a machine's IPv6 default route is
// black-holed — a VPN or Tailscale owning ::/0 is the everyday case — the IPv6 attempt dies at
// once, and the still-in-flight IPv4 attempt never gets to win. The whole connect then reports
// ETIMEDOUT, which `fetch` collapses into a bare "fetch failed".
//
// The hub is a single Fly machine in SJC, so a TCP connect from outside North America straddles
// that line (215–405 ms measured from Seoul). The result was an intermittent, unexplainable
// `inplan login: fetch failed` against a hub that was serving 200s throughout — and the same
// 250 ms budget sits under every other hub call: the wait loop, the plugin gate's entitlement
// probe, presence, the npm update check.
//
// Widening the budget KEEPS Happy Eyeballs — a genuinely IPv6-only network still falls through to
// the second family, just later — and the extra wait is only ever paid on a network where the
// first family is already dead. The status quo turns a slow-but-healthy path into a hard failure,
// which is strictly worse than making a dead path take a moment longer to admit it.

import net from "node:net";

/** Long enough to cover a trans-Pacific connect to a single-region host with headroom, short
 *  enough that a genuinely dead first family is given up on while the user is still watching. */
export const CONNECT_ATTEMPT_TIMEOUT_MS = 2000;

/**
 * Raise this process's per-address connect budget to `ms`, and report the budget now in force.
 *
 * A FLOOR, not an assignment: anyone who already set a LONGER budget (via
 * `--network-family-autoselection-attempt-timeout` or NODE_OPTIONS) keeps it. An operator who
 * turned the race off entirely with `--no-network-family-autoselection` is unaffected either way —
 * that disables the second attempt, leaving this knob nothing to time.
 *
 * Returns null on a runtime too old to expose the knob (Node < 18.18): nothing to widen, and
 * nothing that should stop the CLI from starting.
 */
export function widenConnectAttemptBudget(ms: number = CONNECT_ATTEMPT_TIMEOUT_MS): number | null {
  const get = net.getDefaultAutoSelectFamilyAttemptTimeout;
  const set = net.setDefaultAutoSelectFamilyAttemptTimeout;
  if (typeof get !== "function" || typeof set !== "function") return null;
  const current = get();
  if (Number.isFinite(current) && current >= ms) return current;
  try {
    set(ms);
  } catch {
    // A future Node may reject a value this one accepts. A budget we couldn't widen is the
    // behaviour we have today — never a reason to fail startup.
    return Number.isFinite(current) ? current : null;
  }
  return ms;
}
