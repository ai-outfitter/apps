import compiled from "../graph/.compiled/exploration-fixture.json" with { type: "json" };
// The read-only demo's exploration: a fictional company, its offerings, projects,
// a repository with open pull requests, a competitor and one staged proposal.
// The page resolves it in the browser with the same code the server runs
// (lib/exploration-picture.ts); a visitor's clicks change it for that page only.
import { memorySource } from "@ai-outfitter/app-sdk/graph-graphql";
import { applyMergePatch } from "@ai-outfitter/app-sdk/merge-patch";
import { defaultTypes } from "../src/lib/default-types";
import { changeExploration, type ExplorationState, explorationState, mutateExplorationInput, type PictureProviders, resolvePicture } from "../src/lib/exploration-picture";

const stamp = { revision: 1, createdBy: "demo", updatedBy: "demo", createdAt: 1792886400000, updatedAt: 1792886400000 };
const nodes = compiled.nodes.map(node => ({ ...node, source: null, ...stamp }));
const edges = compiled.edges.map(edge => ({ ...edge, ...stamp }));
const source = memorySource({ installationId: "demo", types: defaultTypes.map((row) => ({ ...row, ...stamp, seedVersion: 1 })), nodes, edges } as never);

const pulls = [
  { number: 42, title: "Read the BH1750 light sensor over I2C", state: "OPEN" },
  { number: 41, title: "Deep sleep between readings", state: "OPEN" },
].map((pull) => ({ ...pull, url: `https://github.com/fernway/fw1-firmware/pull/${pull.number}`, createdAt: "2026-11-02T15:00:00Z", updatedAt: "2026-11-06T15:00:00Z", closedAt: null, mergedAt: null }));
const providers: PictureProviders = {
  pullRequests: async (repository) => (repository === "fernway/fw1-firmware" ? pulls : []),
  // An agent proposed a competitor; it stays dashed until a member commits the batch.
  proposals: async () => [
    { batchId: "demo", ref: "$rachio", operation: { operation: "create", type: "graph-node", ref: "$rachio", attributes: { typeId: "Product", title: "Rachio soil probe" } } },
    { batchId: "demo", ref: "$alt", operation: { operation: "create", type: "graph-edge", ref: "$alt", attributes: { typeId: "alternative_for", fromId: "$rachio", toId: "fernway-for-growers" } } },
  ],
};

const initial: ExplorationState = explorationState.parse({
  title: "Fernway offerings",
  start: { type: "Organization", slug: "fernway" },
  steps: {
    offerings: { from: "Organization:fernway", path: "offerings" },
    projects: { from: "*offerings", path: "projects" },
    repositories: { from: "*projects", path: "repositories" },
    pulls: { from: "*repositories", path: "pullRequests" },
    competitors: { from: "*offerings", path: "competitors" },
  },
});

export const demoExplorations = [{ slug: "fernway-offerings", title: initial.title }];

/** One page's copy of the demo exploration: reads and merge patches, never saved. */
export function demoExploration() {
  let state = initial, revision = 3;
  let lastChange = { by: "Vega", via: "app", summary: "Opened projects, repositories, open pull requests and competitors", nodes: [] as string[] };
  const read = async () => ({ slug: "fernway-offerings", title: state.title, revision, state, lastChange, picture: await resolvePicture(source, state, providers) });
  return {
    read,
    async mutate(raw: unknown) {
      const input = mutateExplorationInput.parse(raw);
      if (input.expectedRevision !== revision) throw new Error("Read the exploration again.");
      const change = await changeExploration(source, state, input, { by: "you", via: "member" }, providers);
      state = explorationState.parse(applyMergePatch(state, input.patch));
      revision += 1;
      lastChange = change.lastChange;
      return { ...(await read()), picture: change.picture };
    },
  };
}
