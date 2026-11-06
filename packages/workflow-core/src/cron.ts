import { Cron } from "croner";

// Five-field cron schedules for workflow triggers. The platform checks schedules
// once per 15-minute tick, so a schedule may fire up to 15 minutes late, and no
// two occurrences may be closer than the minimum interval while we learn the load.

export const MIN_SCHEDULE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const HORIZON_MS = 366 * 24 * 60 * 60 * 1000;

function parse(cron: string, timezone: string) {
  if (!/^\S+( \S+){4}$/.test(cron))
    throw new Error("must be a five-field cron");
  return new Cron(cron, { timezone, paused: true });
}

/**
 * Why a cron cannot be a schedule, or undefined when it can. Spacing is measured
 * in UTC, so a daylight-saving shift in the schedule's zone does not reject it.
 */
export function cronIssue(cron: string) {
  let pattern: Cron;
  try {
    pattern = parse(cron, "UTC");
  } catch (error) {
    return error instanceof Error ? error.message : "is not a valid cron";
  }
  // A year of occurrences catches lists and ranges that run too close together.
  const start = new Date();
  let previous = pattern.nextRun(start);
  if (!previous) return "never runs";
  for (let count = 0; count < 1500; count++) {
    const next = pattern.nextRun(previous);
    if (!next || next.getTime() - start.getTime() > HORIZON_MS) return;
    if (next.getTime() - previous.getTime() < MIN_SCHEDULE_INTERVAL_MS)
      return `runs more often than every ${MIN_SCHEDULE_INTERVAL_MS / 3_600_000} hours`;
    previous = next;
  }
}

/** The first occurrence strictly after `after`, in milliseconds. */
export function nextOccurrence(cron: string, timezone: string, after: number) {
  const next = parse(cron, timezone).nextRun(new Date(after));
  if (!next) throw new Error(`${cron} never runs`);
  return next.getTime();
}

/** Whether `timezone` is an IANA zone this runtime knows. */
export function knownTimezone(timezone: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}
