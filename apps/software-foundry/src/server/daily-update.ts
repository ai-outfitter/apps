import { scheduledAppUpdate } from "@ai-outfitter/app-sdk/daily-update";
import { githubPullRequests } from "@ai-outfitter/app-sdk/github-pulls";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";

export const dailyWorkflow = "software-foundry-daily-update";

export function dailyUpdate(
  host: WorkflowHost<"schedule">,
  actor: AppIdentity,
  raw: unknown,
) {
  return scheduledAppUpdate(
    host,
    actor,
    raw,
    "Software Foundry",
    dailyWorkflow,
    async (period) => {
      const { connections } = await host.call("snapshot", {});
      const github = connections.filter(
        (c) => c.provider === "github" && c.owner === "organization",
      );
      const repositories = [
        ...new Set(github.flatMap((c) => c.repositories)),
      ].sort();
      const rows = [];
      let complete = repositories.length > 0;
      for (const repository of repositories) {
        let after: string | null = null;
        try {
          for (let page = 0; page < 5; page++) {
            const { nodes, pageInfo } = await githubPullRequests(
              host,
              repository,
              100,
              after,
            );
            for (const { title, url, mergedAt } of nodes) {
              if (
                mergedAt &&
                Date.parse(mergedAt) >= period.start &&
                Date.parse(mergedAt) < period.end
              )
                rows.push({ repository, title, url, mergedAt });
            }
            if (rows.length > 30) return { rows, complete: false };
            if (
              !pageInfo.hasNextPage ||
              (nodes.length &&
                Date.parse(nodes[nodes.length - 1].updatedAt) < period.start)
            )
              break;
            if (
              page === 4 ||
              !pageInfo.endCursor ||
              pageInfo.endCursor === after
            ) {
              complete = false;
              break;
            }
            after = pageInfo.endCursor;
          }
        } catch {
          complete = false;
        }
      }
      return { rows, complete };
    },
  );
}
