import { stableGraphId } from "@ai-outfitter/app-sdk/graph-client";
import { threadProvider, type ProviderInput } from "@ai-outfitter/app-sdk/threads";
import { planningEntity } from "./entities";
import { listUseCases, saveUseCase, useCaseInput } from "./use-cases";
import { intakeConversationInstructions, intakeQuestions } from "./intake-conversation";
import { actionAgent } from "@ai-outfitter/app-sdk/action-agent";
import { defineAction, publishActionTools } from "@ai-outfitter/app-sdk/actions";
import { ProposalStore } from "./proposals";
import { z } from "zod";
import {
  releaseFitInput, setIntakeReleaseFit, createIntake, intakeInput, intakePageReads, IntakeService, type IntakeContext, previewIntakeInput, previewIntakeWork, read, resetSubmission,
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
  return ["intake.create", "intake.revise-scope", "intake.release-fit"].includes(name)
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
  "intake.release-fit": write("Record the confirmed release-fit decision and rationale using an existing Release revision; never approves delivery", releaseFitInput, setIntakeReleaseFit),
  "intake.release-options": read("Read existing project-linked Releases and their revisions before deciding release fit", z.strictObject({ projectId: z.uuid() }), (s, v) => s.releaseReview(v.projectId)),
  "intake.list": intakePageReads["intake.list"],
  "intake.projects": read("Read existing canonical project identities before assigning an intake", z.strictObject({ offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(100).default(20) }), (s,v) => planningEntity(s.c.db(), "project").list(s.c.identity, v.offset, v.limit)),
  "intake.use-cases": read("Read full existing project-linked use-case scenarios before authoring", z.strictObject({ projectId: z.uuid() }), (s,v) => listUseCases(s.c.db(), s.c.identity, s.c.host(), v.projectId)),
  "intake.save-use-case": write("Prepare a complete use-case scenario for explicit review; existing records need ID and revision", useCaseInput, (s,v) => saveUseCase(s.c.db(), s.c.identity, s.c.host(), v)),
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
      "intake.save-use-case",
      "intake.release-fit",
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
            "intake.release-fit",
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
  const agent = actionAgent({
    store: new ProposalStore(context.store(), context.identity),
    host: context.host(),
    type: "planning.discovery-conversation",
    contextType: "planning.discovery",
    focusId: intakeAgentFocus,
    label: "Customer and competitive intake",
    context: () => context,
    actions,
    reads: Object.fromEntries(
      ["intake.projects", "intake.use-cases", "intake.list", "intake.get", "intake.options", "intake.preview", "intake.release-options"].map((name) => [
        name,
        sidebarActions[name as keyof typeof sidebarActions],
      ]),
    ),
    instructions:
      intakeConversationInstructions + " In this sidebar use the available intake.* read and proposal tools for the matching steps; use intake.projects and intake.use-cases for canonical context. You help define customer problems, use cases, user stories, competitors and products in Planning. Explain the available intake, child work, controls and blockers. Propose intake and routing changes for explicit member review. Do not invent controls, assignments, research findings, or completion. Implementation submission requires the exact inspected work package.",
    page: async () => ({
      intake: (await new IntakeService(context).list())
        .slice(0, 10)
        .map((row) => ({
          ...intakeQuestions(row),
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
      ownerScope: context.identity.owner,
      installationId: context.identity.installationId,
      nextAction: "Ask the next unresolved project, use-case or release-fit question before preparing a reviewed change.",
      coverage:
        "First ten intake summaries; full details remain available through intake.list and intake.get",
    }),
  });
  const prepare = async (input: ProviderInput<"prepare">) => {
    const prepared = await agent.prepare(input);
    const conversationSource = { threadId: input.thread.id, messageId: input.entry.id,
      requestId: await stableGraphId(context.identity.owner, context.identity.installationId, "planning-conversation-intake", input.thread.id, input.entry.id) };
    return { ...prepared, context: { ...prepared.context as Record<string, never>, conversationSource } };
  };
  return { ...agent, prepare,
    provider: threadProvider({ types: () => agent.types, prepare, tool: agent.tool, deleted: agent.deleting }) };
}
