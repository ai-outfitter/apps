import { z } from "zod";
import { projectRollup } from "./report-summary";
import type { AppIdentity } from "@ai-outfitter/app-sdk/server";
import type { WorkflowHost } from "@ai-outfitter/app-sdk/workflow-host";
import {
  readAppUpdate,
  writeAppUpdate,
} from "@ai-outfitter/app-sdk/daily-update";
import type { ReportPeriod } from "./report-period";
import type { ReportChain } from "./report-chain";

export async function collectAppUpdates(
  host: Pick<WorkflowHost<"interactive">, "call">,
  actor: AppIdentity,
  period: ReportPeriod,
  projects: ReportChain["projects"],
  runId: string,
) {
  const producers = ["Workshop", "Software Foundry", "Planning", "Onto"];
  let expected = ["Planning"];
  if (actor.owner.kind === "organization") {
    try {
      const viewer = await host.call("platform.document", {
        document: "Viewer",
        kind: "query",
        variables: {},
        query: "query { viewer { orgs { appSlugs } } }",
      });
      const { appSlugs } = z
        .object({
          viewer: z.object({
            orgs: z.tuple([z.object({ appSlugs: z.array(z.string()) })]),
          }),
        })
        .parse(viewer).viewer.orgs[0];
      expected = producers.filter(
        (app) =>
          app === "Planning" ||
          appSlugs.includes(app.toLowerCase().replaceAll(" ", "-")),
      );
    } catch {
      // When installation discovery fails, keep every possible missing producer visible.
      expected = producers;
    }
  }
  return Promise.all(
    expected.map(async (app) => {
      try {
        if (app === "Planning")
          await writeAppUpdate(host, actor, app, period, runId, async () => ({
            summary: projectRollup(projects).slice(0, 650),
            rows: projects.map((p) => ({
              project: p.summary.name,
              summary: p.summary.summary,
              document: p.report?.slug,
              revision: p.report?.revision,
            })),
            complete: projects.every((p) => p.status === "complete"),
          }));
        const saved = await readAppUpdate(host, app, period);
        if (saved) return saved;
      } catch {
        /* Each missing source stays visible in the organization overview. */
      }
      return {
        app,
        status: "incomplete" as const,
        summary: "Daily update unavailable.",
        report: null,
      };
    }),
  );
}
