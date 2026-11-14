/** Seconds as the page shows them: "3s", "1:05". */
export function seconds(value: number | null) {
  if (value === null) return "";
  if (value < 60) return `${+value.toFixed(1)}s`;
  return `${Math.floor(value / 60)}:${String(Math.round(value % 60)).padStart(2, "0")}`;
}

/** "15s · 9:16 · Social", leaving out what is not set. */
export const facts = (...parts: (string | null | undefined)[]) => parts.filter(Boolean).join(" · ");
