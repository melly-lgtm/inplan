// SPDX-License-Identifier: AGPL-3.0-or-later

import { LogEventType, readLog } from "@inplan/core/node";

/** Is a process with this pid currently alive? (signal 0 = existence check). */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The most recently logged editor pid (regardless of liveness), else null. */
export function latestEditorPid(logPath: string): number | null {
  const entries = readLog(logPath);
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i]!.type === LogEventType.EditorPid) {
      const pid = (entries[i]!.payload as { pid?: number } | undefined)?.pid;
      return typeof pid === "number" ? pid : null;
    }
  }
  return null;
}

/** The pid of a still-running editor for this document (from the latest editor_pid entry), else null. */
export function runningEditorPid(logPath: string): number | null {
  const pid = latestEditorPid(logPath);
  return pid !== null && isProcessAlive(pid) ? pid : null;
}
