// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The event announcing a plugin-carried edit and the plugin's own delivery of it are not ordered.
// A read that adopts whatever the binding holds the instant the event arrives can adopt the text
// from BEFORE the revision — and the editor then writes its next programmatic change, built on
// that, back over the revision.

import { describe, expect, it } from "vitest";
import { readWhenCaughtUp, sha256Hex } from "../src/bindingRead";

const doc = (body: string) => ({ body });
const noSleep = { sleep: async () => {}, retries: 5 };

describe("reading a binding once it holds what landed", () => {
  it("hashes exactly as the CLI does (sha-256, hex, utf-8)", async () => {
    expect(await sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("returns at once when the binding already holds it", async () => {
    let reads = 0;
    const got = await readWhenCaughtUp(() => (reads++, doc("landed")), (await sha256Hex("landed"))!, () => false, noSleep);
    expect(got?.body).toBe("landed");
    expect(reads).toBe(1);
  });

  it("WAITS past pre-revision text for the body that landed", async () => {
    const seen = ["before the turn", "before the turn", "landed"];
    const got = await readWhenCaughtUp(() => doc(seen.shift()!), (await sha256Hex("landed"))!, () => false, noSleep);
    expect(got?.body).toBe("landed");
  });

  it("reads past an unreadable binding too", async () => {
    const seen: Array<{ body: string } | null> = [null, null, doc("landed")];
    const got = await readWhenCaughtUp(() => seen.shift()!, (await sha256Hex("landed"))!, () => false, noSleep);
    expect(got?.body).toBe("landed");
  });

  it("gives up waiting and hands back what the binding holds — it may simply be AHEAD", async () => {
    // Someone typed after the revision landed: that hash will never be seen again, and the
    // binding is still the live document. Never resolving would freeze the preview.
    let reads = 0;
    const got = await readWhenCaughtUp(() => (reads++, doc("landed, plus a keystroke")), (await sha256Hex("landed"))!, () => false, noSleep);
    expect(got?.body).toBe("landed, plus a keystroke");
    expect(reads).toBe(6); // the first read and five retries — bounded
  });

  it("resolves nothing when the binding was never readable", async () => {
    expect(await readWhenCaughtUp(() => null, "x", () => false, noSleep)).toBeNull();
  });

  it("resolves nothing once abandoned, even if the text then arrives", async () => {
    let abandoned = false;
    const seen = ["before the turn", "landed"];
    const got = await readWhenCaughtUp(() => doc(seen.shift()!), (await sha256Hex("landed"))!, () => abandoned, { retries: 5, sleep: async () => void (abandoned = true) });
    expect(got).toBeNull();
  });

  it("does not check where there is nothing to check with", async () => {
    const got = await readWhenCaughtUp(() => doc("whatever is there"), "some-hash", () => false, { ...noSleep, hash: async () => null });
    expect(got?.body).toBe("whatever is there");
  });
});
