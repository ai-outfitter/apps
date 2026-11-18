import type { IntakeRow } from "./intake";

/** Shared guidance for Planning's sidebar and main Chat's discoverable document contract. */
export const intakeConversationInstructions = "When a member describes a new customer need, feature, idea or competitive change, first ask the concrete missing question: whose problem, desired outcome and success evidence, then which existing project it belongs to. Offer a persisted CreateIntake rather than only summarizing the conversation. Read Projects and Intakes through graph_query to match existing records and avoid duplicate work; do not assume the selected project owns the idea. After the member confirms capture, use CreateIntake with conversationSource.requestId and originatingMessage; keep that request ID on retries. Read IntakeReleaseOptions for the chosen project before asking whether the request fits a selected Release now, belongs in a later existing Release or backlog, needs research, or should be rejected. Record the confirmed rationale through SetIntakeReleaseFit at the revision read. Research, architecture and prioritization are existing claimed child work: use ClaimWork, SaveResultDraft and RecordResult; never invent findings or approvals. A complete use case includes actor, goal, trigger, normal steps, alternatives and observable successCriteria; use UseCases then SaveUseCase when the member confirms. Read ProjectDelivery for outstanding questions and handoff evidence. IntakeWorkPreview and SubmitIntakeWork require current discovery and release fit, explicit delivery approval, and the exact reviewed package. Ask the next unresolved question, and distinguish a proposal, saved decision, research result, approved work and actual delivery. Only graph_mutate runs confirmed document mutations; generic proposal tools prepare private proposals.";

export function intakeQuestions(row: IntakeRow) {
  const questions: string[] = [];
  const fit = row.body.releaseFit;
  if (fit?.disposition !== "rejected" && !(row.body.projectId ?? row.body.input.projectId)) questions.push("Which existing project should own this request?");
  if (!fit) questions.push("Does this request fit an existing Release now, belong in a later Release or backlog, need research, or merit rejection? What is the rationale?");
  else if (fit.disposition === "needs-research") questions.push("What evidence would resolve the release-fit decision, and who should perform the research?");
  // A recorded deferral is a decision, not a new unanswered question on every report.
  for (const route of row.body.routes) {
    if (fit?.disposition !== "rejected" && route.result?.gaps.length) questions.push(...route.result.gaps.map(gap => `${route.kind}: ${gap}`));
  }
  return { intakeId: row.id, revision: row.revision, title: row.body.input.title,
    releaseFit: fit ?? null, questions, routes: row.body.routes.map(route => ({ id: route.id, kind: route.kind, revision: route.revision, resultSubmitted: Boolean(route.result) })) };
}
