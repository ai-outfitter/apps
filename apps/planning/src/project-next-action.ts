/** Presentation only: preserve persisted question identity and report coverage. */
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function projectNextAction(delivery: unknown, report: unknown) {
  const decisions = record(record(delivery).intakeDecisions);
  const questions = (Array.isArray(decisions.items) ? decisions.items : []).flatMap(value=>{
    const item=record(value);
    const pending=Array.isArray(item.questions) ? item.questions.filter((question):question is string=>typeof question==="string") : [];
    return pending.length ? [{id:String(item.intakeId ?? ""),title:String(item.title ?? "Request"),revision:Number(item.revision),questions:pending}] : [];
  });
  const preparation=record(record(delivery).preparation);
  const blockers=(Array.isArray(preparation.blockers)?preparation.blockers:[]).flatMap(value=>{
    if(typeof value==="string")return [{message:value,remediation:""}];
    const blocker=record(value);return typeof blocker.message==="string" ? [{message:blocker.message,remediation:typeof blocker.remediation==="string"?blocker.remediation:""}] : [];
  });
  if(typeof preparation.dispatchError==="string" && preparation.dispatchError)blockers.push({message:preparation.dispatchError,remediation:"Review work preparation before retrying."});
  const preparationQuestions=(Array.isArray(preparation.questions)?preparation.questions:[]).flatMap(value=>{
    const question=record(value);return typeof question.question==="string" ? [typeof question.requirement==="string" ? `${question.requirement}: ${question.question}` : question.question] : [];
  });
  if(preparationQuestions.length)questions.push({id:String(preparation.id??"preparation"),title:"Work preparation",revision:Number(preparation.projectRevision),questions:preparationQuestions});
  const captured=record(report);
  return {questions,blockers,preparationState:typeof preparation.state==="string"?preparation.state:"",truncated:decisions.truncated===true,
    summary:typeof captured.summary==="string" ? captured.summary : "",
    incomplete:captured.status==="incomplete",coverage:typeof captured.coverage==="string" ? captured.coverage : "",
    reference:record(captured.reference),
  };
}
