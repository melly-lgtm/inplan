// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Render an ISO timestamp as a human relative string ("a few seconds ago",
// "a minute ago", "10 years ago") with the exact local date-time in the hover
// tooltip. Re-renders itself on an interval so the relative text stays fresh
// without the parent having to tick.

import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { useEffect, useState } from "react";

dayjs.extend(relativeTime);

/** How often to refresh the relative text (ms). 30s keeps "seconds/minutes ago" honest. */
const REFRESH_MS = 30_000;

export function RelativeTime({ iso, className }: { iso: string; className?: string }): JSX.Element {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const d = dayjs(iso);
  if (!d.isValid()) return <span className={className}>{iso}</span>;
  return (
    <time className={className} dateTime={iso} title={d.format("MMM D, YYYY, h:mm:ss A")}>
      {d.fromNow()}
    </time>
  );
}
