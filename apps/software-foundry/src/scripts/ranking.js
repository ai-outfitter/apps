// Project milestones span repositories: every open GitHub milestone with the
// same title is one milestone, ranked by that title. Mirrors groupMilestones
// and rankMilestones in src/server/ranking.ts for demo fixtures.

export function milestoneKey(title) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

export function groupMilestones(repositories, open) {
  const order = (milestone) => {
    const index = repositories.indexOf(milestone.repository);
    return index < 0 ? repositories.length : index;
  };
  const groups = new Map();
  for (const milestone of [...open].sort((a, b) => order(a) - order(b))) {
    const key = milestoneKey(milestone.title);
    groups.set(key, [...(groups.get(key) ?? []), milestone]);
  }
  return [...groups].map(([key, parts]) => {
    const dates = parts.flatMap((part) => (part.dueOn ? [part.dueOn] : [])).sort();
    return {
      key,
      title: parts[0].title,
      description: parts.find((part) => part.description)?.description ?? "",
      dueOn: dates[0] ?? null,
      openItems: parts.reduce((total, part) => total + part.openItems, 0),
      closedItems: parts.reduce((total, part) => total + part.closedItems, 0),
      parts: parts.map(({ repository, number, url }) => ({ repository, number, url })),
    };
  });
}

export function rankMilestones(ranking, milestones) {
  const rank = new Map(ranking.map((key, index) => [key, index]));
  const position = (item) => rank.get(item.key) ?? Number.POSITIVE_INFINITY;
  const due = (item) =>
    item.dueOn ? Date.parse(item.dueOn) : Number.POSITIVE_INFINITY;
  const compare = (a, b) => (a === b ? 0 : a < b ? -1 : 1);
  return [...milestones].sort(
    (a, b) =>
      compare(position(a), position(b)) ||
      compare(due(a), due(b)) ||
      a.title.localeCompare(b.title),
  );
}

/** The ranking, as milestone titles, after moving one up (-1) or down (+1). */
export function moved(milestones, index, offset) {
  const target = index + offset;
  if (target < 0 || target >= milestones.length) return null;
  const order = milestones.map((milestone) => milestone.key);
  [order[index], order[target]] = [order[target], order[index]];
  return order;
}
