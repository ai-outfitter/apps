import launchWeek from "../fixtures/forerunner-day.launch-week.json" with { type: "json" };

/** The synthetic day the demo adapter and tests read by stable ID. */
export const day = launchWeek;

export type Stone = (typeof day.stones)[number];

const byId = <T extends { id: string }>(records: readonly T[], id: string, kind: string) => {
  const found = records.find((record) => record.id === id);
  if (!found) throw new Error(`Unknown ${kind}: ${id}`);
  return found;
};

export const stones: readonly Stone[] = [...day.stones].sort((a, b) => a.rank - b.rank);
export const stone = (id: string) => byId(day.stones, id, "stone");
export const signal = (id: string) => byId(day.signals, id, "signal");
export const commitment = (id: string) => byId(day.commitments, id, "commitment");

/** The selected stone for a `?priority=` value; the top stone when it names none. */
export const selectedStone = (id: string | null) => day.stones.find((s) => s.id === id) ?? stones[0];

export const priorityHref = (id: string) => `?priority=${encodeURIComponent(id)}`;

/** What the agent sidebar needs per stone: its focus and its scripted dialogue. */
export const agentScopes = stones.map(({ id, title, dialogue }) => ({ id, title, dialogue }));
export type AgentScope = (typeof agentScopes)[number];
