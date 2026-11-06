import {foundryRunStatus} from "./status";
import { setOrganizationLink } from "../../../navigation.js";
import { onPageLoad } from "@ai-outfitter/ui/page";
import { workflowClient, type Workflow, type WorkflowRun, type WorkflowSubscription, type ExecutorBinding } from "@ai-outfitter/app-sdk/workflows";
import { runNodes } from "./nodes";
import { renderNodeEvidence } from "./evidence";
setOrganizationLink("software-foundry");
const element = <T = ReturnType<typeof document.createElement>>(id: string) =>
  document.getElementById(id) as unknown as T;
let notice: HTMLElement;
let select: HTMLSelectElement;
let inputs: HTMLTextAreaElement;
let save: HTMLButtonElement;
const api = workflowClient();
const demo = import.meta.env.OUTFITTER_APP_MODE === "demo";
let definitions: Workflow[] = [];
let subscriptions: WorkflowSubscription[] = [];
let selection = 0;
let detailSelection = 0;
let bindings: ExecutorBinding[] = [];
let bindingsTruncated = false;
let bindingRequest = 0;
let bindingError = "Loading executor configuration…";
function text(tag: string, value: string) {
  const node = document.createElement(tag);
  node.textContent = value;
  return node;
}
function report(error: unknown) {
  notice.textContent = error instanceof Error ? error.message : String(error);
}
function showRun(run: WorkflowRun) {
  const host = element("workflow-run");
  host.replaceChildren(text("h3", `${run.workflow.id} · ${foundryRunStatus(run)}`));
  if (run.dispatch?.error) host.appendChild(text("p", run.dispatch.error));
  for (const node of runNodes(run)) {
    const details = document.createElement("details");
    details.open =
      node.status === "running" ||
      node.status === "blocked" ||
      node.status === "failed";
    details.appendChild(
      text(
        "summary",
        `${node.id} · ${node.actorKind ?? "evidence"} · graph: ${node.status}`,
      ),
    );
    for (const attempt of node.attempts) {
      if (attempt.taskStatus) details.appendChild(text("p", `Resident task: ${attempt.taskStatus.state.replaceAll("-", " ")} · observed ${new Date(attempt.taskStatus.observedAt).toLocaleString()}`));
      details.appendChild(text("p", `Execution: ${attempt.state} · updated ${new Date(attempt.updatedAt).toLocaleString()}`));
    }
    if (!node.attempts.length) details.appendChild(text("p", "No recorded execution attempt."));
    if (node.instructions) details.appendChild(text("p", node.instructions));
    details.appendChild(renderNodeEvidence(run, node.id, node.evidence));
    const outputs = document.createElement("details");
    outputs.appendChild(text("summary", "Recorded workflow outputs"));
    outputs.appendChild(text("pre", JSON.stringify(node.evidence, null, 2)));
    details.appendChild(outputs);
    host.appendChild(details);
  }
}
async function loadRuns() {
  const request = ++selection;
  ++detailSelection;
  const workflow = select.value;
  const list = element("workflow-runs");
  element("workflow-run").replaceChildren();
  list.replaceChildren(text("li", "Loading runs…"));
  const { items } = await api.runs(workflow);
  if (request !== selection) return;
  list.replaceChildren();
  if (!items.length) list.appendChild(text("li", "No runs yet."));
  for (const run of items) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.className = "secondary";
    button.textContent = `${new Date(run.createdAt).toLocaleString()} · ${foundryRunStatus(run)}`;
    button.addEventListener("click", async () => {
      const detailRequest = ++detailSelection;
      try {
        const pinned = await api.run(run.id);
        if (request === selection && detailRequest === detailSelection) {
          showRun(pinned);
          history.replaceState(
            history.state,
            "",
            `/workflows?workflow=${encodeURIComponent(workflow)}&run=${encodeURIComponent(run.id)}`,
          );
        }
      } catch (error) {
        if (request === selection && detailRequest === detailSelection)
          report(error);
      }
    });
    item.appendChild(button);
    list.appendChild(item);
  }
}
/** The repository the managed settings name: an organization GitHub connection and its repository id. */
function subscriptionTarget(value: Record<string, unknown>) {
  const settings = value["github-webhook.inputs.settings"] as { connectionId?: unknown; resource?: unknown } | undefined;
  const connectionId = typeof settings?.connectionId === "string" ? settings.connectionId.trim() : "";
  const resource = typeof settings?.resource === "string" ? settings.resource.trim() : "";
  if (!connectionId || !resource) throw new Error("Name the repository's connectionId and resource in the managed settings.");
  return { connectionId, resource };
}
function subscriptionInputs() {
  const value = JSON.parse(inputs.value) as Record<string, unknown>;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Enter the managed inputs.");
  const target = subscriptionTarget(value);
  if (subscriptions.some((item) => item.connectionId === target.connectionId && item.resource === target.resource)) throw new Error("This repository already has a subscription. An administrator must update it explicitly.");
  for (const [slot, actor, kind] of [["triageBinding", "triager", "external"], ["engineerBinding", "engineer", "external"], ["reviewerBinding", "reviewer", "resident"]]) {
    const id = value[`github-webhook.inputs.${slot}`];
    if (!bindings.some((binding) => binding.id === id && binding.workflowId === select.value && binding.actor === actor && binding.kind === kind && binding.enabled && binding.configuration.valid))
      throw new Error(`Choose an approved ${actor} binding from the list.`);
  }
  return value;
}
function updateSave() {
  try { subscriptionInputs(); save.disabled = demo || Boolean(bindingError) || bindingsTruncated; }
  catch { save.disabled = true; }
}
function showBindings() {
  if (bindingError) {
    element("workflow-bindings").replaceChildren(text("li", bindingError));
    element("workflow-binding-limit").textContent = "";
    return;
  }
  const assigned = bindings.filter((binding) => binding.workflowId === select.value);
  element("workflow-bindings").replaceChildren(...assigned.map((binding) => text("li",
    `${binding.label} · ${binding.actor} · ${binding.kind} · ${!binding.enabled ? "disabled" : binding.configuration.valid ? "configuration valid" : "configuration unavailable"} · ${binding.model ?? "model unavailable"} · profile ${binding.profile?.id ?? "unavailable"}`,
  )));
  if (!assigned.length) element("workflow-bindings").appendChild(text("li", bindingsTruncated ? "No bindings for this workflow in the returned results." : "No approved bindings listed for this workflow."));
  element("workflow-binding-limit").textContent = bindingsTruncated ? "The binding list is incomplete. An administrator must check the remaining bindings." : "";
}
async function loadBindings() {
  const request = ++bindingRequest;
  try {
    const approved = await api.bindings();
    if (request !== bindingRequest) return;
    bindings = approved.items; bindingsTruncated = approved.truncated; bindingError = "";
  } catch {
    if (request !== bindingRequest) return;
    bindings = []; bindingsTruncated = false;
    bindingError = "Executor configuration is unavailable. Refresh to try again.";
  }
  showBindings();
  updateSave();
}
async function selected() {
  const definition = definitions.find((item) => item.id === select.value);
  if (!definition) return;
  element("workflow-summary").textContent = definition.summary;
  element("workflow-nodes").replaceChildren(
    ...definition.steps.map((step) =>
      text(
        "li",
        `${step.id} · ${step.actor ? definition.actors[step.actor]?.kind : "evidence"}`,
      ),
    ),
  );
  showBindings();
  element("workflow-subscriptions").replaceChildren(
    ...subscriptions
      .filter((item) => item.workflowId === definition.id)
      .map((item) =>
        text(
          "li",
          `${item.connectionId} / ${item.resource} · ${item.enabled ? "enabled" : "disabled"}`,
        ),
      ),
  );
  const existing = subscriptions.find((item) => item.workflowId === definition.id);
  inputs.value = JSON.stringify(
    existing?.inputs ?? {
      "github-webhook.inputs.triageBinding": "",
      "github-webhook.inputs.engineerBinding": "",
      "github-webhook.inputs.reviewerBinding": "",
      "github-webhook.inputs.settings": {
        model: "gpt-6-luna",
        engineerProfile: "engineer",
        connectionId: "",
        resource: "",
      },
    },
    null,
    2,
  );
  updateSave();
  try {
    await loadRuns();
  } catch (error) {
    report(error);
  }
}
// Configuration is not an access preflight; execution still checks current access and bindings.
async function subscribe(event: SubmitEvent, signal: AbortSignal) {
  event.preventDefault();
  if (demo || save.disabled) return;
  try {
    const managedInputs = subscriptionInputs();
    save.disabled = true;
    await api.saveSubscription({ ...subscriptionTarget(managedInputs), workflowId: select.value, inputs: managedInputs, enabled: true, createOnly: true });
    const stored = (await api.subscriptions()).items;
    // After the next page swapped in, this page's results go nowhere.
    if (signal.aborted) return;
    subscriptions = stored;
    await selected();
    if (!signal.aborted) notice.textContent = "Subscription created. New issues can start this workflow; repository access and execution are checked on each run.";
  } catch (error) {
    if (signal.aborted) return;
    report(error);
    updateSave();
  }
}
async function initialize(signal: AbortSignal) {
  if (demo) {
    notice.textContent =
      "Demo mode is read-only. Workflow execution and subscription changes require an operational installation.";
    element<HTMLButtonElement>("workflow-refresh").disabled = true;
    return;
  }
  void loadBindings();
  const [catalog, stored] = await Promise.all([
    api.catalog(),
    api.subscriptions(),
  ]);
  if (signal.aborted) return;
  definitions = catalog.workflows.map((item) => item.definition);
  subscriptions = stored.items;
  select.replaceChildren(
    ...definitions.map(
      (definition) => new Option(definition.id, definition.id),
    ),
  );
  select.disabled = !definitions.length;
  save.disabled = true;
  const params = new URLSearchParams(location.search);
  const requestedWorkflow = params.get("workflow");
  const requestedRun = params.get("run");
  if (
    requestedWorkflow &&
    definitions.some((item) => item.id === requestedWorkflow)
  )
    select.value = requestedWorkflow;
  notice.textContent = definitions.length
    ? "Workflows from this installation’s approved package."
    : "No workflows in this installation’s approved package.";
  const initialLoad = selected();
  const initialSelection = selection;
  await initialLoad;
  if (requestedRun && initialSelection === selection) {
    const request = ++detailSelection;
    const run = await api.run(requestedRun);
    if (request === detailSelection) showRun(run);
  }
}
onPageLoad((signal) => {
  const definition = element<HTMLSelectElement | null>("workflow-definition");
  if (!definition) return;
  select = definition;
  notice = element("workflow-notice");
  inputs = element<HTMLTextAreaElement>("workflow-inputs");
  save = element<HTMLButtonElement>("workflow-save");
  // Requests still running when the page is left must not render.
  signal.addEventListener("abort", () => {
    selection++;
    detailSelection++;
    bindingRequest++;
  });
  bindingError = "Loading executor configuration…";
  inputs.addEventListener("input", updateSave);
  select.addEventListener("change", selected);
  element("workflow-refresh").addEventListener("click", () => {
    void loadBindings();
    void selected();
  });
  element<HTMLFormElement>("workflow-subscription").addEventListener("submit", (event) => subscribe(event, signal));
  initialize(signal).catch((error) => {
    if (!signal.aborted) report(error);
  });
});
