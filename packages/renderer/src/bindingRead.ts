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
 * Read a document from a binding once its body is the one that landed.
 *
 * `read` returns the binding's document, or null when it cannot be read right now (a legacy
 * binding caught mid-edit). Resolves the first read whose body hashes to `bodyHash`; null as soon
 * as `abandoned()` says the caller has moved on (navigated, re-bound, a newer event).
 *
 * When the wait runs out it resolves the LAST readable document anyway. A mismatch that outlives
 * the wait is far more likely the binding being AHEAD — someone typed after the revision landed,
 * so its hash will never be seen again — than behind, and in both cases the binding is the live
 * shared document and the only copy this editor can show. Never resolving would freeze the
 * preview on the text from before the turn.
 */
export async function readWhenCaughtUp<T extends { body: string }>(
  read: () => T | null,
  bodyHash: string,
  abandoned: () => boolean,
  opts: CaughtUpOptions = {},
): Promise<T | null> {
  const { intervalMs = 100, retries = 20, hash = sha256Hex, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = opts;
  let last: T | null = null;
  for (let attempt = 0; ; attempt++) {
    if (abandoned()) return null;
    const doc = read();
    if (doc) {
      last = doc;
      const h = await hash(doc.body);
      if (abandoned()) return null;
      if (h === null || h === bodyHash) return doc; // null: nothing to check with — as if unstamped
    }
    if (attempt >= retries) return last;
    await sleep(intervalMs);
  }
}
