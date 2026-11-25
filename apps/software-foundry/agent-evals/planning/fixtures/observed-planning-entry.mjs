// Test-only pass-through at the installed Planning worker's host boundary.
// Record operation and destination names only. Never copy arguments or replies.
import { appendFileSync } from "node:fs";
import entry from "./original-planning-entry.mjs";

export default {
  fetch(request, env, context) {
    const host = context.props?.workflowHost;
    if (!host) return entry.fetch(request, env, context);
    const workflowHost = {
      call(operation, input) {
        const { app, installationId, action, document } = input ?? {};
        appendFileSync("/out/planning-host.jsonl",
          JSON.stringify({ operation, app, installationId, action, document }) + "\n");
        return host.call(operation, input);
      },
    };
    return entry.fetch(request, env, { ...context, props: { ...context.props, workflowHost } });
  },
};
