import assert from "node:assert/strict";
import test from "node:test";
import * as client from "../src/scripts/ranking.js";
import { groupMilestones, milestoneKey, rankMilestones } from "../src/server/ranking";

const milestone = (
  repository: string,
  number: number,
  title: string,
  dueOn: string | null,
  description = "",
) => ({
  repository,
  number,
  title,
  description,
  dueOn,
  openItems: 2,
  closedItems: 1,
  url: `https://github.com/${repository}/milestone/${number}`,
});
const open = [
  milestone("team/api", 4, "Design tokens", "2026-12-01T00:00:00Z", "API press release"),
  milestone("team/web", 2, "design  Tokens", "2026-11-01T00:00:00Z"),
  milestone("team/web", 3, "Faster starts", "2026-10-01T00:00:00Z"),
  milestone("team/api", 5, "Audit export", null),
];

test("milestones with the same title span repositories as one milestone", () => {
  for (const group of [groupMilestones, client.groupMilestones]) {
    const grouped = group(["team/web", "team/api"], open);
    const tokens = grouped.find((item) => item.key === "design tokens");
    assert.ok(tokens);
    // The first repository's title, the first written press release, the
    // earliest due date and the summed progress.
    assert.equal(tokens.title, "design  Tokens");
    assert.equal(tokens.description, "API press release");
    assert.equal(tokens.dueOn, "2026-11-01T00:00:00Z");
    assert.deepEqual([tokens.openItems, tokens.closedItems], [4, 2]);
    assert.deepEqual(
      tokens.parts.map((part: { repository: string; number: number }) => [
        part.repository,
        part.number,
      ]),
      [["team/web", 2], ["team/api", 4]],
    );
    assert.equal(grouped.length, 3);
  }
  assert.equal(milestoneKey(" Design\tTokens "), "design tokens");
});

test("ranked milestones come first in rank order, then by due date, undated last", () => {
  const grouped = groupMilestones(["team/web", "team/api"], open);
  // A ranked title with no open milestone is skipped.
  const ranking = ["audit export", "gone", "design tokens"];
  const expected = ["Audit export", "design  Tokens", "Faster starts"];
  assert.deepEqual(rankMilestones(ranking, grouped).map((item) => item.title), expected);
  assert.deepEqual(client.rankMilestones(ranking, grouped).map((item) => item.title), expected);
  assert.deepEqual(rankMilestones([], grouped).map((item) => item.title), [
    "Faster starts",
    "design  Tokens",
    "Audit export",
  ]);
  assert.deepEqual(client.moved(rankMilestones(ranking, grouped), 0, 1), [
    "design tokens",
    "audit export",
    "faster starts",
  ]);
  assert.equal(client.moved(grouped, 0, -1), null);
});
