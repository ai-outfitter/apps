/** Local-only, repeatable concept revisions for inspecting the Products UI.
 * node --import tsx apps/planning/scripts/seed-product-revisions.mjs --organization artera --origin http://ncrmro-workstation:4392
 */
import { parseArgs } from "node:util";
import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
const { values } = parseArgs({
  options: {
    organization: { type: "string" },
    origin: { type: "string", default: "http://localhost:4392" },
  },
});
const origin = new URL(values.origin).origin;
if (new URL(origin).protocol !== "http:")
  throw new Error("Use the local development server's HTTP origin");
const slug = values.organization;
if (!slug) throw new Error("--organization is required");
const login = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify({
    email: "local@example.test",
    password: "local-orgs-only",
  }),
});
if (!login.ok) throw new Error(`Local login failed (${login.status})`);
const cookie = login.headers
  .getSetCookie()
  .map((value) => value.split(";")[0])
  .join("; ");
async function post(path, input) {
  const response = await fetch(origin + path, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: cookie,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(input),
  });
  if (!response.ok)
    throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response.json();
}
const answer = await post("/api/graphql", {
  query:
    "query($slugs:[String!]){viewer{orgs(slugs:$slugs){products{id title revisions{id}} weeklyProductRoadmap{sourceContext}}}}",
  variables: { slugs: [slug] },
  organizationSlugs: [slug],
  personal: false,
});
if (answer.errors?.length) throw new Error(JSON.stringify(answer.errors));
const orgs = answer.data.viewer.orgs;
if (orgs.length !== 1)
  throw new Error("Exactly one accessible organization is required");
const org = orgs[0],
  wiki = org.weeklyProductRoadmap.sourceContext.wikiInstallationId;
const base = `/o/${encodeURIComponent(slug)}/wiki-map/api/apps/wiki-map/graph`;
async function typeId(name) {
  const rows = await post(`${base}/list`, {
    type: "graph-type",
    filter: { name, archived: false },
    limit: 2,
  });
  if (rows.length !== 1) throw new Error(`${name} type missing or ambiguous`);
  if (
    name === "ProductRevision" &&
    !rows[0].attributes.jsonSchema?.properties?.stage?.enum?.includes("concept")
  )
    throw new Error(
      "Update the local ProductRevision definition to the current concept-capable Wiki schema before seeding",
    );
  return rows[0].ref.id;
}
const revisionType = await typeId("ProductRevision"),
  relationshipType = await typeId("revision_of");
for (const product of org.products) {
  if (product.revisions.length) {
    console.log(`${product.title}: existing revisions preserved`);
    continue;
  }
  const id = await stableGraphId(
    "local-product-concept-seed-v1",
    wiki,
    product.id,
  );
  await post(`${base}/create`, {
    type: "graph-node",
    attributes: {
      id,
      typeId: revisionType,
      title: "Seed concept revision",
      summary: `Local sample for ${product.title}. Design intent only; no build, release or approval is asserted.`,
      body: JSON.stringify({ stage: "concept" }),
    },
  });
  await post(`${base}/create`, {
    type: "graph-edge",
    attributes: {
      id: await stableGraphId(
        "local-product-concept-seed-link-v1",
        wiki,
        product.id,
      ),
      typeId: relationshipType,
      fromId: id,
      toId: product.id,
    },
  });
  console.log(`${product.title}: seeded concept revision`);
}
