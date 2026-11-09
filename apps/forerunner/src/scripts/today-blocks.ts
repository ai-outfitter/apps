/** Pure builders for the Today timeline, shared by the page script and its tests. */
export type IconName = "video" | "pick" | "msg" | "gift" | "link" | "graph" | "stone" | "suggestion";

/** One row of the Today timeline: a calendar event, the current block, or a batch of small tasks. */
export type Block = {
  id: string;
  time?: string;
  kind: "event" | "now" | "batch";
  title: string;
  done?: boolean;
  proof?: string;
  length?: string;
  action?: { label: string; href: string };
  items?: BatchItem[];
};
export type BatchItem = { id: string; title: string; action: string; icon: IconName; href: string };

export type BoardItem = { id: string; category: "stone" | "pebble" | "sand"; title: string; dueDate: string | null; status: "todo" | "in-progress" | "done"; parentId: string | null; position: number };

/** The day's look-and-approve items: the daily run's open suggestions, then graph changes waiting for review. */
function reviewItems(suggestions: number, waiting: number): BatchItem[] {
  const items: BatchItem[] = [];
  if (suggestions) items.push({ id: "review:suggestions", title: `Look at ${suggestions} ${suggestions === 1 ? "suggestion" : "suggestions"}`, action: "Look", icon: "suggestion", href: "workflows#suggestions" });
  if (waiting) items.push({ id: "review:graph", title: `Approve ${waiting} ${waiting === 1 ? "change" : "changes"} to your knowledge graph`, action: "Review", icon: "graph", href: "graph?status=pending" });
  return items;
}

/**
 * The operational timeline, from the member's own board and the latest
 * discovery run: what is in progress now, what is due, the next step of
 * each stone, the small tasks, the daily run's open suggestions and, last, the
 * changes waiting for review.
 */
export function blocksFromBoard(items: BoardItem[], waiting: number, today: string, suggestions = 0): Block[] {
  const open = items.filter((item) => item.status !== "done").sort((a, b) => a.position - b.position);
  const stones = open.filter((item) => item.category === "stone");
  const pebbles = open.filter((item) => item.category === "pebble");
  const sand = open.filter((item) => item.category === "sand");
  const blocks: Block[] = [];
  const link = (item: BoardItem) => `board?item=${encodeURIComponent(item.id)}`;
  const task = (item: BoardItem, action: string, iconName: IconName): BatchItem => ({ id: item.id, title: item.title, action, icon: iconName, href: link(item) });
  const current = open.find((item) => item.status === "in-progress") ?? pebbles[0] ?? stones[0];
  if (current) blocks.push({ id: `now:${current.id}`, kind: "now", title: current.title, action: { label: "Open on the board", href: link(current) } });
  const due = open.filter((item) => item.dueDate && item.dueDate <= today && item.id !== current?.id);
  if (due.length) blocks.push({ id: "batch:due", kind: "batch", title: "Due today", length: `${due.length} ${due.length === 1 ? "item" : "items"}`, items: due.slice(0, 6).map((item) => task(item, item.dueDate && item.dueDate < today ? "Overdue" : "Due", "pick")) });
  const next = stones.map((stone) => pebbles.find((p) => p.parentId === stone.id && p.id !== current?.id && !due.includes(p))).filter((p): p is BoardItem => Boolean(p));
  if (next.length) blocks.push({ id: "batch:next", kind: "batch", title: "Next steps", length: `${next.length} ${next.length === 1 ? "stone" : "stones"}`, items: next.slice(0, 5).map((item) => task(item, "Next", "stone")) });
  const small = sand.filter((item) => item.id !== current?.id && !due.includes(item)).slice(0, 5);
  const review = reviewItems(suggestions, waiting);
  if (small.length || review.length) blocks.push({ id: "batch:small", kind: "batch", title: "Small tasks", length: `${small.length + review.length} ${small.length + review.length === 1 ? "item" : "items"}`, items: [...small.map((item) => task(item, "Sand", "pick")), ...review] });
  return blocks;
}
