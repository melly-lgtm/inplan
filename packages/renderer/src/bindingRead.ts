// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Reading an agent's edit out of a plugin's binding — and knowing whether it is there yet.
//
// The event announcing a plugin-carried edit and the plugin's own delivery of that edit travel
// separately, and nothing orders them. Read the binding the moment the event arrives and it may
// still hold the text from BEFORE the revision. Adopting that as "the document" is worse than
// showing a stale preview: the editor builds its next programmatic change (a span comment's
// anchor, find/replace, a block move, an undo) on what it adopted and writes the result back
// through the binding — over the revision, once it does arrive.
//
// So the event carries a hash of the body that landed, and the read waits for the binding to hold
// it.

/** sha-256 hex of `text`, byte for byte what the CLI records — or null where WebCrypto is missing. */
export async function sha256Hex(text: string): Promise<string | null> {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export interface CaughtUpOptions {
  /** How long to wait between reads, and how many more reads to make after the first. Together
   *  they bound the wait (2s by default): delivery over a live connection takes milliseconds. */
  intervalMs?: number;
  retries?: number;
  hash?: (text: string) => Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Resolve once a binding's body is the one that landed — the moment to read it.
 *
 * `readBody` returns the binding's body, or null when it cannot be read right now (a legacy
 * binding caught mid-edit). Only the body: this runs on every poll, and building the whole
 * document each time to hash one field of it is wasted work. Resolves true as soon as a read
 * hashes to `bodyHash`; false as soon as `abandoned()` says the caller has moved on
 * (a newer event, a re-bind, another document).
 *
 * It resolves a SIGNAL, never the document it looked at. Hashing awaits, and a keystroke landing
 * in the binding during that await would make any document handed back here already stale — the
 * very thing this exists to prevent. The caller reads again, synchronously, when told to.
 *
 * When the wait runs out it resolves true anyway. A mismatch that outlives the wait is far more
 * likely the binding being AHEAD — someone typed after the revision landed, so its hash will
 * never be seen again — than behind, and in both cases the binding is the live shared document
 * and the only copy this editor can show. Never resolving would freeze the preview on the text
 * from before the turn.
 */
export async function whenCaughtUp(
  readBody: () => string | null,
  bodyHash: string,
  abandoned: () => boolean,
  opts: CaughtUpOptions = {},
): Promise<boolean> {
  const { intervalMs = 100, retries = 20, hash = sha256Hex, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = opts;
  for (let attempt = 0; ; attempt++) {
    if (abandoned()) return false;
    const body = readBody();
    if (body !== null) {
      const h = await hash(body);
      if (abandoned()) return false;
      if (h === null || h === bodyHash) return true; // null: nothing to check with — as if unstamped
    }
    if (attempt >= retries) return true;
    await sleep(intervalMs);
  }
}
