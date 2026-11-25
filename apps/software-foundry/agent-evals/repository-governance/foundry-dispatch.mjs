// Adapt the Foundry Astro handlers to webapp's existing in-process Node app
// dispatch. The platform supplies the workflow host scope and identity headers.
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const app = join(process.env.FOUNDRY_EVAL_APPS_CHECKOUT, "apps/software-foundry");
const handlers = new Map([
  ["/api/apps/software-foundry/jobs", "src/pages/api/apps/software-foundry/jobs.ts"],
  ["/api/internal/workflow-host/v1", "src/pages/api/internal/workflow-host/v1.ts"],
]);

export default {
  async fetch(request, _env, context) {
    const handler = handlers.get(new URL(request.url).pathname);
    if (!handler) return new Response("Unexpected fixture app dispatch", { status: 404 });
    const route = await import(pathToFileURL(join(app, handler)).href);
    const method = route[request.method];
    return method ? method({ request, locals: { cfContext: context } }) : new Response(null, { status: 405 });
  },
};
