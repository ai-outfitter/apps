import { z } from "zod";
export const reviewInput = z.strictObject({ date: z.iso.date().optional(), timezone: z.string().min(1).max(64).default("America/Chicago") });
const day = 86_400_000;
export const shiftDate = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * day).toISOString().slice(0, 10);
export function localDate(at: number, timezone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}
function midnight(date: string, timezone: string) {
  const approximate = Date.parse(`${date}T00:00:00Z`);
  let low = approximate - 36 * 3_600_000, high = approximate + 36 * 3_600_000;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (localDate(middle, timezone) < date) low = middle + 1; else high = middle; }
  return low;
}
/** Completed local days only; 23/25-hour DST days retain their real boundaries. */
export function reviewPeriod(raw: z.input<typeof reviewInput>, now = Date.now()) {
  const input = reviewInput.parse(raw);
  let today: string;
  try { today = localDate(now, input.timezone); } catch { throw new Response("Choose a valid time zone", { status: 400 }); }
  const date = input.date ?? shiftDate(today, -1);
  if (date >= today) throw new Response("Choose yesterday or an earlier date", { status: 400 });
  return { date, timezone: input.timezone, start: midnight(date, input.timezone), end: midnight(shiftDate(date, 1), input.timezone) };
}
export type ReviewPeriod = ReturnType<typeof reviewPeriod>;
