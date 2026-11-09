import { append, el } from "./dom";
import { duration, modelAnswer, stepTimes } from "./run-model";
import { runPage, type RunPage } from "./run-page";
import { conclusionList, json } from "./run-view";

type Time = { at: string; ms?: number };
const roles: Record<string, string> = { system: "System", user: "Forerunner", model: "Agent", check: "Check" };
function turn(times: Map<string, Time>, role: string, title: string, step: string, ...body: Node[]) {
  const li = el("li", `run-turn run-turn--${role}`);
  const head = el("div", "run-turn-head");
  append(head, el("span", "run-turn-role", roles[role]), el("strong", undefined, title));
  const time = times.get(step);
  if (time) {
    const label = new Date(time.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
    head.appendChild(el("time", "run-turn-time", label + (time.ms === undefined ? "" : ` · ${duration(time.ms)}`)));
  }
  append(li, head, ...body);
  return li;
}
function raw(label: string, value: unknown) {
  const details = el("details", "run-raw");
  append(details, el("summary", undefined, label), el("pre", undefined, json(value)));
  return details;
}
function prompt(context: RunPage) {
  const details = el("details", "run-prompt");
  details.id = "activity-prompt";
  append(details, el("summary", undefined, "Show the full prompt"), el("pre", undefined, context.run.systemPrompt ?? context.preview?.systemPrompt ?? "Not recorded for this run."));
  return details;
}
function sent(context: RunPage) {
  const input = context.run.input as { evidence?: { ref: string; title: string }[] } | undefined;
  if (!input || typeof input !== "object") return el("p", "muted", context.run.note ?? "Not recorded.");
  const body = el("div", "run-sent");
  const items = el("ol", "run-sent-list");
  for (const evidence of input.evidence ?? []) {
    const li = el("li");
    const ref = el("a", "run-ref", evidence.ref);
    ref.title = "Open this item";
    const self = evidence.ref === "operating-user";
    if (!self) ref.href = `${context.base}/inputs?item=${encodeURIComponent(evidence.ref)}`;
    append(li, ref, el("span", undefined, self ? "Who you are" : evidence.title.split(" · ")[0]));
    items.appendChild(li);
  }
  append(body, items, raw("Model input", input));
  return body;
}
function answer(context: RunPage) {
  const body = el("div");
  if (modelAnswer(context.run)) body.appendChild(conclusionList(context, context.list.filter(c => c.evidence.length || c.note)));
  body.appendChild(raw("Raw answer", context.run.output));
  return body;
}
runPage("transcript", (context) => {
  const { run, preview, byId } = context;
  const times = new Map(stepTimes(run.stages).map(step => [step.status, step]));
  const out: Node[] = [turn(times, "system", "System prompt", "preparing", prompt(context)), turn(times, "user", "Sent to the agent", "reading", sent(context))];
  if (run.output !== undefined) out.push(turn(times, "model", "The agent answered", "analyzing", answer(context)));
  const warnings = Array.isArray(run.warnings) ? run.warnings : preview?.warnings;
  // Do not claim validation passed when a run failed before it reached that step.
  const checked = run.stages?.some(stage => stage.status === "validating");
  if (checked || warnings?.length) out.push(turn(times, "check", "Checks", "validating", el("p", undefined, warnings?.length ? warnings.join(" ") : "All passed.")));
  if (preview?.receipt) {
    const counts = preview.receipt.counts ?? {};
    out.push(turn(times, "check", "Saved", "saving", el("p", undefined, `${counts.committed ?? 0} added, ${counts.awaiting_review ?? 0} in review.`)));
  }
  if (run.status === "failed") out.push(turn(times, "check", "Failed", run.failedWhile ?? "failed", el("p", "run-failure", byId("activity-run-error").textContent ?? "")));
  byId("run-transcript").replaceChildren(...out);
});
