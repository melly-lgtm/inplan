// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Self-update over npm. inplan is distributed as a global npm install
// (`npm install -g <pkg>`), so "is there a newer version?" is a registry lookup
// and "update" is `npm install -g <pkg>@latest` — no packaged installer, code
// signing, or release feed needed (Electron rides along as a dependency). The
// editor surfaces this via the app→CLI shell-out, the same as the profile menu.

import { spawn } from "node:child_process";

/** The npm package the global install resolves to (override for forks / scoped names). */
export const UPDATE_PKG = process.env.INPLAN_PKG || "agent-planner";

/** Compare dotted versions numerically (prerelease suffixes ignored). <0 if a<b. */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v
      .split("-")[0]!
      .split(".")
      .map((n) => Number.parseInt(n, 10) || 0);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** The latest published version of `pkg`, or null if the registry can't be reached. */
export async function latestVersion(pkg: string): Promise<string | null> {
  try {
    const res = await fetch(`https://registry.npmjs.org/${pkg.replace("/", "%2F")}/latest`, { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const data = (await res.json()) as { version?: string };
    return typeof data.version === "string" ? data.version : null;
  } catch {
    return null;
  }
}

export interface UpdateCheck {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
}

/** Whether a newer version is published than `current`. `fetchLatest` is injectable for tests. */
export async function checkForUpdate(opts: { pkg: string; current: string; fetchLatest?: (pkg: string) => Promise<string | null> }): Promise<UpdateCheck> {
  const latest = await (opts.fetchLatest ?? latestVersion)(opts.pkg);
  return { current: opts.current, latest, updateAvailable: latest !== null && compareVersions(opts.current, latest) < 0 };
}

/** Install the latest version globally. Resolves with the npm exit status + output. */
export function selfUpdate(pkg: string): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const child = spawn("npm", ["install", "-g", `${pkg}@latest`], { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout?.on("data", (d) => (output += d));
    child.stderr?.on("data", (d) => (output += d));
    child.on("error", (e) => resolve({ ok: false, output: e.message }));
    child.on("close", (code) => resolve({ ok: code === 0, output: output.trim() }));
  });
}
