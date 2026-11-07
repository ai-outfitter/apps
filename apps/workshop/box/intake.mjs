// Request intake for the Workshop box. Each /in/requests/*.json design request
// (box/schemas/design-request.schema.json) is checked for the fields the
// driver relies on and given its folder, designs/<slug>.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { slugify } from "../../../box/lib.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9][a-z0-9-]{0,63}$/;
const message = (value) => typeof value === "string" && value.trim().length > 0 && value.trim().length <= 500;

/** Each check is [passes, message]; the first that fails names the request. */
function check(name, checks) {
  const failed = checks.find(([passes]) => !passes);
  if (failed) throw new Error(`${name}: ${failed[1]}`);
}

/** The request fields the driver relies on; the full schema lives in box/schemas. */
export function parseRequest(value, name = "request") {
  check(name, [[value && typeof value === "object" && !Array.isArray(value), "must be a JSON object"]]);
  const followUps = value.followUps ?? [];
  check(name, [
    [value.schemaVersion === 1, "schemaVersion must be 1"],
    [typeof value.requestId === "string" && uuid.test(value.requestId), "requestId must be a UUID"],
    [typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 200, "title needs 1 to 200 characters"],
    [message(value.message), "message needs 1 to 500 characters"],
    [Array.isArray(followUps) && followUps.length <= 8 && followUps.every(message), "followUps are up to 8 messages of 1 to 500 characters"],
    [value.slug === undefined || slug.test(value.slug), "slug must be a lowercase slug"],
  ]);
  return {
    ...value,
    requestId: value.requestId.toLowerCase(),
    message: value.message.trim(),
    followUps: followUps.map((text) => text.trim()),
    slug: value.slug ?? slugify(value.title),
  };
}

/** Every request file in a folder, in name order; two requests may not share a folder. */
export function readRequests(directory) {
  let names;
  try {
    names = readdirSync(directory).filter((name) => name.endsWith(".json")).sort();
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const requests = names.map((name) => ({ name, request: parseRequest(JSON.parse(readFileSync(join(directory, name), "utf8")), name) }));
  const slugs = requests.map(({ request }) => request.slug);
  const duplicate = slugs.find((value, index) => slugs.indexOf(value) !== index);
  if (duplicate) throw new Error(`Two requests design into designs/${duplicate}; give one a slug`);
  return requests;
}

