// Placeholder delivery metrics for the dashboard, generated from the project
// name so each project shows stable numbers until Foundry records merges,
// runs, traffic and deploys of its own.

function seeded(name) {
  let state = 2166136261;
  for (const char of name) state = Math.imul(state ^ char.charCodeAt(0), 16777619);
  return () => {
    state = Math.imul(state ^ (state >>> 15), 2246822507);
    state = Math.imul(state ^ (state >>> 13), 3266489909);
    state ^= state >>> 16;
    return (state >>> 0) / 4294967296;
  };
}

const days = (random, low, high) =>
  Array.from({ length: 7 }, () => Math.round(low + random() * (high - low)));
const sum = (values) => values.reduce((total, value) => total + value, 0);

export function projectMetrics(project) {
  const random = seeded(project);
  const merged = days(random, 1, 9);
  const closed = days(random, 0, 7);
  const runs = days(random, 3, 18);
  const traffic = days(random, 40, 420);
  const deploys = days(random, 0, 3);
  const previous = (values) => Math.round(sum(values) * (0.7 + random() * 0.6));
  const hours = Math.round(4 + random() * 30);
  return {
    merged: { value: sum(merged), previous: previous(merged), series: merged },
    closed: { value: sum(closed), previous: previous(closed), series: closed },
    "time-to-merge": { value: hours, previous: Math.round(hours * (0.8 + random() * 0.5)), unit: "h", lowerIsBetter: true },
    runs: { value: sum(runs), previous: previous(runs), series: runs, note: `${Math.round(80 + random() * 18)}% succeeded` },
    traffic: { value: sum(traffic), previous: previous(traffic), series: traffic },
    deploys: { value: sum(deploys), previous: previous(deploys), series: deploys },
  };
}

const BLOCKS = "▁▂▃▄▅▆▇█";
/** Seven days as a one-line text sparkline. */
export function sparkline(series) {
  const max = Math.max(...series, 1);
  return series.map((value) => BLOCKS[Math.round((value / max) * (BLOCKS.length - 1))]).join("");
}
