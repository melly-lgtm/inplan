// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event announcing a plugin-carried edit and the plugin's own delivery of it are not ordered.
// A read that adopts whatever the binding holds the instant the event arrives can adopt the text
// from BEFORE the revision — and the editor then writes its next programmatic change, built on
// that, back over the revision.

import { describe, expect, it } from "vitest";
import { sha256Hex, whenCaughtUp } from "../src/bindingRead";

const doc = (body: string): string => body;
const noSleep = { sleep: async () => {}, retries: 5 };
const LANDED = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"; // sha-256 of "abc"

describe("knowing when a binding holds what landed", () => {
  it("hashes exactly as the CLI does (sha-256, hex, utf-8)", async () => {
    expect(await sha256Hex("abc")).toBe(LANDED);
  });

  it("says so at once when the binding already holds it", async () => {
    let reads = 0;
    expect(await whenCaughtUp(() => (reads++, doc("abc")), LANDED, () => false, noSleep)).toBe(true);
    expect(reads).toBe(1);
  });

  it("WAITS past pre-revision text for the body that landed", async () => {
    const seen = ["before the turn", "before the turn", "abc", "never read"];
    expect(await whenCaughtUp(() => doc(seen.shift()!), LANDED, () => false, noSleep)).toBe(true);
    expect(seen).toEqual(["never read"]); // it stopped on the read that matched, not before
  });

  it("waits past an unreadable binding too", async () => {
    const seen: Array<string | null> = [null, null, doc("abc"), doc("never read")];
    expect(await whenCaughtUp(() => seen.shift()!, LANDED, () => false, noSleep)).toBe(true);
    expect(seen).toHaveLength(1);
  });

  it("gives up waiting, and still says read — the binding may simply be AHEAD", async () => {
    // Someone typed after the revision landed: that hash will never be seen again, and the
    // binding is still the live document. Never resolving would freeze the preview.
    let reads = 0;
    expect(await whenCaughtUp(() => (reads++, doc("abc, plus a keystroke")), LANDED, () => false, noSleep)).toBe(true);
    expect(reads).toBe(6); // the first read and five retries — bounded
  });

  it("says do not read once abandoned, even if the text then arrives", async () => {
    let abandoned = false;
    const seen = ["before the turn", "abc"];
    expect(await whenCaughtUp(() => doc(seen.shift()!), LANDED, () => abandoned, { retries: 5, sleep: async () => void (abandoned = true) })).toBe(false);
  });

  it("…or abandoned while the hash was being computed", async () => {
    let abandoned = false;
    const hash = async (): Promise<string> => ((abandoned = true), LANDED);
    expect(await whenCaughtUp(() => doc("abc"), LANDED, () => abandoned, { ...noSleep, hash })).toBe(false);
  });

  it("does not check where there is nothing to check with", async () => {
    expect(await whenCaughtUp(() => doc("whatever is there"), "some-hash", () => false, { ...noSleep, hash: async () => null })).toBe(true);
  });
});
