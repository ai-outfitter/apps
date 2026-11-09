/** The daily run as GET/POST/PUT `schedule` return it. */
export type Schedule = { enabled: boolean; connectionId: string | null; nextRunAt: number | null; lastRunAt: number | null; lastOutcome: string | null };

/**
 * The daily run, turned on by default when this member has never saved one
 * (`POST schedule {timezone}`; the server never re-enables a run the
 * member turned off). Falls back to reading it, and to null when neither works.
 * Call it only from operational page code: demo bundles must not fetch.
 */
export async function dailySchedule(mount: string, signal: AbortSignal): Promise<Schedule | null> {
  const url = `${mount}/api/apps/forerunner/schedule`;
  const read = async (init?: RequestInit) => {
    const response = await fetch(url, { ...init, signal });
    if (!response.ok) throw new Error(await response.text());
    return ((await response.json()) as { schedule: Schedule }).schedule;
  };
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return read({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ timezone }) })
    .catch(() => read())
    .catch(() => null);
}
