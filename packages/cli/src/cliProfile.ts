// SPDX-License-Identifier: AGPL-3.0-or-later
//
// The human's local identity (name/email) used to author comments, kept in
// `~/.inplan/profile.json`. Resolution order: a stored profile wins; otherwise we
// derive it from the signed-in cloud account, then from the doc directory's git
// config, persisting whatever we find. If nothing resolves, the editor prompts
// the human to fill it in (Edit profile), which writes a `manual` profile.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { currentUser } from "./cliAuth";
import { gitIdentity } from "./provenance";

export type IdentitySource = "cloud" | "git" | "manual";
export interface LocalProfile {
  name: string;
  email?: string;
  source: IdentitySource;
}

/** `~/.inplan/profile.json`. `INPLAN_HOME` overrides the base dir (tests). */
export function profilePath(): string {
  const base = process.env.INPLAN_HOME || join(homedir(), ".inplan");
  return join(base, "profile.json");
}

/** Read the stored profile, or null when absent/corrupt/nameless. */
export function readLocalProfile(): LocalProfile | null {
  const p = profilePath();
  if (!existsSync(p)) return null;
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<LocalProfile>;
    if (typeof raw.name !== "string" || raw.name.trim() === "") return null;
    const source: IdentitySource = raw.source === "cloud" || raw.source === "git" ? raw.source : "manual";
    return { name: raw.name.trim(), ...(raw.email ? { email: raw.email } : {}), source };
  } catch {
    return null;
  }
}

/** Persist the profile (atomic-enough: single write, pretty JSON). */
export function writeLocalProfile(p: LocalProfile): void {
  const path = profilePath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`);
}

/** Set the manual identity (the Edit-profile form), which overrides git/cloud. */
export function setManualProfile(name: string, email?: string): LocalProfile {
  const prof: LocalProfile = { name: name.trim(), ...(email && email.trim() ? { email: email.trim() } : {}), source: "manual" };
  writeLocalProfile(prof);
  return prof;
}

/** Build a profile from a {name?,email?} source, using email as the name fallback. */
function fromParts(parts: { name?: string; email?: string }, source: IdentitySource): LocalProfile | null {
  const name = (parts.name && parts.name.trim()) || (parts.email && parts.email.trim());
  if (!name) return null;
  return { name, ...(parts.email ? { email: parts.email } : {}), source };
}

/**
 * Resolve (and persist) the human's identity: stored profile → cloud account →
 * git config of `file`'s directory → null. `file` is the doc being edited; when
 * omitted, git resolution is skipped. Returns null only when nothing is found
 * (the editor then asks the human to fill it in).
 */
export async function resolveIdentity(file?: string): Promise<LocalProfile | null> {
  const stored = readLocalProfile();
  if (stored) return stored;

  const user = await currentUser().catch(() => null);
  if (user) {
    const prof = fromParts({ name: user.name, email: user.email }, "cloud");
    if (prof) {
      writeLocalProfile(prof);
      return prof;
    }
  }

  if (file) {
    const git = gitIdentity(dirname(file));
    if (git) {
      const prof = fromParts(git, "git");
      if (prof) {
        writeLocalProfile(prof);
        return prof;
      }
    }
  }

  return null;
}
