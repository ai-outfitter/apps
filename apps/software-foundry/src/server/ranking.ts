// A project milestone spans repositories: every open GitHub milestone with
// the same title in the project's repositories is one milestone, and a
// project ranks its milestones by that title. Pure functions shared by the
// app and the platform's page bootstrap; the browser keeps a copy for demo
// fixtures (src/scripts/ranking.js).

/** A milestone's identity across repositories: its title, case-insensitive. */
export function milestoneKey(title: string) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

type RepositoryMilestone = {
  repository: string;
  number: number;
  title: string;
  description: string;
  dueOn: string | null;
  openItems: number;
  closedItems: number;
  url: string;
};

/**
 * One milestone per title across the project's repositories, in repository
 * order: the first description that is written is its press release, the
 * earliest due date is its due date, and progress adds up.
 */
export function groupMilestones(
  repositories: string[],
  open: RepositoryMilestone[],
) {
  const order = (milestone: RepositoryMilestone) => {
    const index = repositories.indexOf(milestone.repository);
    return index < 0 ? repositories.length : index;
  };
  const groups = new Map<string, RepositoryMilestone[]>();
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
export type ProjectMilestone = ReturnType<typeof groupMilestones>[number];

/**
 * A project's milestones, most important first: the ranked ones in rank
 * order, then the rest by due date (undated last), then by title. Ranked
 * titles with no open milestone are skipped.
 */
export function rankMilestones<T extends { key: string; title: string; dueOn: string | null }>(
  ranking: string[],
  milestones: T[],
) {
  const rank = new Map(ranking.map((key, index) => [key, index]));
  const position = (milestone: T) => rank.get(milestone.key) ?? Number.POSITIVE_INFINITY;
  const due = (milestone: T) =>
    milestone.dueOn ? Date.parse(milestone.dueOn) : Number.POSITIVE_INFINITY;
  const compare = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);
  return [...milestones].sort(
    (a, b) =>
      compare(position(a), position(b)) ||
      compare(due(a), due(b)) ||
      a.title.localeCompare(b.title),
  );
}
