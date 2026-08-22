// SPDX-License-Identifier: AGPL-3.0-or-later
//
// openInBrowser's launch REPORT (cliLogin.ts). The spawn was long treated as fire-and-forget, so
// the only way login could tell whether a browser had come up was to wait for the page's ack and
// give up on a timeout — which cannot tell "there is no browser here" apart from "the browser is
// still starting", and therefore called slow machines broken. The opener does say so, plainly: a
// missing binary arrives as an 'error' event, and `open`/`xdg-open` exit non-zero when they cannot
// handle the URL. These cases pin that those signals reach the caller — exactly once.

import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import { openInBrowser } from "../src/cliLogin";

/** A stand-in for the opener process: an emitter with the `unref` the real code calls. */
class FakeChild extends EventEmitter {
  unref = vi.fn();
}

let child: FakeChild;
beforeEach(() => {
  child = new FakeChild();
  spawn.mockReset();
  spawn.mockReturnValue(child);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("openInBrowser", () => {
  it("reports nothing while the launch looks healthy (exit 0)", () => {
    const onLaunchFailure = vi.fn();
    openInBrowser("https://web.test/cli-auth", onLaunchFailure);
    child.emit("exit", 0);
    expect(onLaunchFailure).not.toHaveBeenCalled();
    expect(child.unref).toHaveBeenCalledOnce(); // never keeps the CLI alive waiting on the browser
  });

  it("reports a MISSING opener — the async 'error' event, which is the real headless-Linux case", () => {
    const onLaunchFailure = vi.fn();
    openInBrowser("https://web.test/cli-auth", onLaunchFailure);
    child.emit("error", Object.assign(new Error("spawn xdg-open ENOENT"), { code: "ENOENT" }));
    // CERTAIN: no opener process exists, so no browser is coming and the caller may bail at once.
    expect(onLaunchFailure).toHaveBeenCalledOnce();
    expect(onLaunchFailure).toHaveBeenCalledWith("no-opener");
  });

  it("reports a non-zero exit as SUSPICION, not a verdict — some configs exit non-zero having launched", () => {
    const onLaunchFailure = vi.fn();
    openInBrowser("https://web.test/cli-auth", onLaunchFailure);
    child.emit("exit", 1);
    // The distinction is the whole point: `opener-declined` must not license an immediate
    // "the browser did not open", because the opener exits in milliseconds and would always beat
    // the page's ack — so acting on it would call a working browser broken.
    expect(onLaunchFailure).toHaveBeenCalledOnce();
    expect(onLaunchFailure).toHaveBeenCalledWith("opener-declined");
  });

  it("reports a synchronous spawn throw too (no opener binary at all)", () => {
    spawn.mockImplementation(() => {
      throw new Error("EACCES");
    });
    const onLaunchFailure = vi.fn();
    openInBrowser("https://web.test/cli-auth", onLaunchFailure);
    expect(onLaunchFailure).toHaveBeenCalledOnce();
    expect(onLaunchFailure).toHaveBeenCalledWith("no-opener"); // nothing spawned at all
  });

  it("reports at most ONCE, however many ways the same launch fails", () => {
    // 'error' is normally followed by an 'exit' with a non-zero/null code. One failed launch must
    // not look like several to a caller that counts.
    const onLaunchFailure = vi.fn();
    openInBrowser("https://web.test/cli-auth", onLaunchFailure);
    child.emit("error", new Error("ENOENT"));
    child.emit("exit", null);
    // …and the FIRST, most certain report is the one that stands.
    expect(onLaunchFailure).toHaveBeenCalledOnce();
    expect(onLaunchFailure).toHaveBeenCalledWith("no-opener");
  });

  it("survives being called with no callback at all (the pre-existing best-effort contract)", () => {
    expect(() => openInBrowser("https://web.test/cli-auth")).not.toThrow();
    expect(() => child.emit("error", new Error("ENOENT"))).not.toThrow(); // must never become an unhandled 'error'
    expect(() => child.emit("exit", 1)).not.toThrow();
  });
});
