// The read-only demo's exploration: a fictional company, its offerings, projects,
// a repository with open pull requests, a competitor and one staged proposal.
// The page resolves it in the browser with the same code the server runs
// (lib/exploration-picture.ts); a visitor's clicks change it for that page only.
import { memorySource } from "@ai-outfitter/app-sdk/graph-graphql";
import { applyMergePatch } from "@ai-outfitter/app-sdk/merge-patch";
import { defaultTypes } from "../src/lib/default-types";
import { changeExploration, type ExplorationState, explorationState, mutateExplorationInput, type PictureProviders, resolvePicture } from "../src/lib/exploration-picture";

const stamp = { revision: 1, createdBy: "demo", updatedBy: "demo", createdAt: 1792886400000, updatedAt: 1792886400000 };
const type = (name: string) => {
  const found = defaultTypes.find((row) => row.name === name);
  if (!found) throw new Error(`Demo exploration needs the ${name} type`);
  return found.id;
};
const id = (i: number) => `74000000-0000-4000-8000-${String(i).padStart(12, "0")}`;
const node = (i: number, typeName: string, title: string, slug: string, website: string | null = null) => ({
  id: id(i), typeId: type(typeName), slug, title, summary: null, body: "", website, source: null, properties: {}, archived: false, ...stamp,
});
const edge = (i: number, typeName: string, from: number, to: number) => ({
  id: id(100 + i), typeId: type(typeName), fromId: id(from), toId: id(to), title: null, body: "", properties: {}, archived: false, validity: null, ...stamp,
});

const nodes = [
  node(1, "Organization", "Fernway", "fernway"),
  node(2, "Offering", "Fernway home kit", "fernway-home-kit"),
  node(3, "Offering", "Fernway for growers", "fernway-for-growers"),
  node(4, "Product", "FW-1 soil sensor", "fw-1"),
  node(5, "Project", "FW-1 firmware", "fw-1-firmware"),
  node(6, "Project", "FW-1 enclosure", "fw-1-enclosure"),
  node(7, "Repository", "fernway/fw1-firmware", "fw1-firmware", "https://github.com/fernway/fw1-firmware"),
  node(8, "Organization", "Loam Labs", "loam-labs"),
  node(9, "Product", "Loam soil probe", "loam-soil-probe"),
];
const edges = [
  edge(1, "offered_by", 2, 1),
  edge(2, "offered_by", 3, 1),
  edge(3, "packages_product", 2, 4),
  edge(4, "packages_product", 3, 4),
  edge(5, "produces", 5, 4),
  edge(6, "produces", 6, 4),
  edge(7, "source_in", 5, 7),
  edge(8, "alternative_for", 9, 2),
  edge(9, "developed_by", 9, 8),
];
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
