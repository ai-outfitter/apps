import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { defineAction, publishActionTools } from "@ai-outfitter/app-sdk/actions";
import { ProposalStore } from "./proposals";
import { z } from "zod";
import {
  createIntake, intakeInput, intakePageReads, IntakeService, type IntakeContext, previewIntakeInput, previewIntakeWork, read, resetSubmission,
  resetSubmissionInput, reviseScope, reviseScopeInput, routeInput, routeIntake, setProject, setProjectInput, submitIntakeInput, submitIntakeWork,
} from "./intake";
export const intakeAgentFocus = "e9500000-0000-4000-8000-000000000001";
export function prepareIntakeAction(
  name: string,
  input: unknown,
  requestId: string,
) {
  const fields = z.record(z.string(), z.unknown()).parse(input);
  if (name === "intake.submit")
    return {
      ...fields,
      work: {
        ...z.record(z.string(), z.unknown()).parse(fields.work),
        requestId,
      },
    };
  return ["intake.create", "intake.revise-scope"].includes(name)
    ? { ...fields, requestId }
    : fields;
}
const write = <S extends z.ZodType>(description: string, input: S, run: (s: IntakeService, value: z.output<S>) => Promise<unknown>) =>
  defineAction({
    description, access: "write", input, output: z.json(),
    run: async (c: IntakeContext, v) => JSON.parse(JSON.stringify(await run(new IntakeService(c), v))),
  });
/** The intake sidebar's tools: proposals a member reviews and approves, and reads. Named once
 * here; they serve this sidebar only (no actions route lists them, so they are no MCP tools). */
const sidebarActions = publishActionTools("planning", {
  "intake.create": write("Capture a shared customer or competitive intake; replay with the same requestId", intakeInput, createIntake),
  "intake.route": write("Propose child routes using the configured model, or explicitly correct unstarted routes", routeInput, routeIntake),
  "intake.submit": write("Explicitly submit this ready implementation work package to Foundry", submitIntakeInput, submitIntakeWork),
  "intake.revise-scope": write("Approve a revised intake scope, preserving previous results and invalidating affected child work", reviseScopeInput, reviseScope),
  "intake.set-project": write("Associate unstarted intake with a canonical Planning project", setProjectInput, setProject),
  "intake.reset-submission": write("Explicitly reset a rejected submission after verifying no delivery record exists", resetSubmissionInput, resetSubmission),
  "intake.get": intakePageReads["intake.get"],
  "intake.options": intakePageReads["intake.options"],
  "intake.preview": read("Preview an implementation route's work package with the intake's discovery records", previewIntakeInput, previewIntakeWork),
});
export function intakeAgent(context: IntakeContext) {
  const actions = Object.fromEntries(
    [
      "intake.create",
      "intake.route",
      "intake.submit",
      "intake.revise-scope",
      "intake.set-project",
      "intake.reset-submission",
    ].map((name) => {
      const action = sidebarActions[name as keyof typeof sidebarActions];
      return [
        name,
        {
          action,
          retry: [
            "intake.create",
            "intake.revise-scope",
            "intake.submit",
          ].includes(name)
            ? ("same-request" as const)
            : ("inspect" as const),
          prepare: (input: unknown, requestId: string) =>
            prepareIntakeAction(name, input, requestId),
        },
      ];
    }),
  );
  return actionAgent({
    store: new ProposalStore(context.store(), context.identity),
    host: context.host(),
    type: "planning.discovery-conversation",
    contextType: "planning.discovery",
    focusId: intakeAgentFocus,
    label: "Customer and competitive intake",
    context: () => context,
    actions,
    reads: Object.fromEntries(
      ["intake.get", "intake.options", "intake.preview"].map((name) => [
        name,
        sidebarActions[name as keyof typeof sidebarActions],
      ]),
    ),
    instructions:
      "You help define customer problems, use cases, user stories, competitors and products in Planning. Explain the available intake, child work, controls and blockers. Propose intake and routing changes for explicit member review. Do not invent controls, assignments, research findings, or completion. Implementation submission requires the exact inspected work package.",
    page: async () => ({
      intake: (await new IntakeService(context).list())
        .slice(0, 10)
        .map((row) => ({
          id: row.id,
          revision: row.revision,
          title: row.body.input.title,
          kind: row.body.input.kind,
          projectId: row.body.projectId,
          routes: row.body.routes.map((child) => ({
            id: child.id,
            kind: child.kind,
            revision: child.revision,
            rationale: child.rationale,
            resultSubmitted: Boolean(child.result),
          })),
        })),
      coverage:
        "First ten intake summaries; full details remain available through intake.get",
    }),
  });
}
