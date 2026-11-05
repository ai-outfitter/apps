// The one workflow component: a compact, outcome-first card that expands into
// the full ordered graph. It renders a view model only (the platform's
// src/lib/workflow-drafts.ts projects definitions into it), so chat, apps and
// review surfaces show the same steps, connections and state. Text is always
// set with textContent: models and imported files supply these strings.

export type WorkflowCardStep = {
  id: string;
  title: string;
  /** Who acts: the agent, the member, or a connected service. */
  actor: "agent" | "owner" | "connector";
  /** Plain-language actor, e.g. "Forerunner", "You review" or "Gmail". */
  who: string;
  description: string;
  /** Step ids this step waits for. */
  after: string[];
  /** Plain-language inputs, e.g. "Replies from Draft replies". */
  reads: string[];
  produces: string[];
  /** Connection labels this step needs. */
  needs: string[];
  /** The member decides here. */
  review: boolean;
  /** Writes to a connected service, after a review. */
  effect: boolean;
  /** Derived run status, when the card shows a run. */
  status?: string;
};

export type WorkflowCardModel = {
  id: string;
  title: string;
  benefit: string;
  /** Plain-language trigger, including its timezone when one is known. */
  schedule: string;
  steps: WorkflowCardStep[];
  connections: { label: string; state: "connected" | "needed" }[];
  state: {
    kind: "draft" | "needs-connection" | "invalid" | "run";
    label: string;
  };
  /** Validation problems; an invalid card shows them instead of a graph. */
  issues: string[];
};

const STATUS_LABELS: Record<string, string> = {
  waiting: "Waiting",
  ready: "Ready",
  running: "In progress",
  done: "Done",
  failed: "Failed",
  blocked: "Blocked",
  "not-applicable": "Skipped",
};

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// appendChild, not append: Workers types also declare an HTMLRewriter Element.
function add(parent: Node, ...children: Node[]) {
  for (const child of children) parent.appendChild(child);
}

/** The steps the summary keeps: every decision and write, plus the first and last. */
function summarySteps(all: WorkflowCardStep[]) {
  const steps = all.filter((step) => step.status !== "not-applicable");
  if (steps.length <= 5) return steps;
  return steps.filter(
    (step, index) =>
      index === 0 || index === steps.length - 1 || step.review || step.effect,
  );
}

/** A chat preview names the source, the agent's work, and the human decision. */
function chatSummarySteps(all: WorkflowCardStep[]) {
  const steps = all.filter((step) => step.status !== "not-applicable");
  const source = steps.find((step) => step.actor === "connector" && !step.effect) ?? steps[0];
  const work = steps.find((step) => step.actor === "agent" && step !== source);
  const review = steps.find((step) => step.review);
  const effect = steps.find((step) => step.effect);
  return [...new Set([source, work, review, effect].filter((step): step is WorkflowCardStep => Boolean(step)))];
}

function detail(label: string, values: string[]) {
  const row = element("div", "workflow-card__detail");
  add(
    row,
    element("dt", undefined, label),
    element("dd", undefined, values.join(" · ")),
  );
  return row;
}

/**
 * A decision's note. Only a review that a write waits on stops anything;
 * other decisions, such as declining a connection, lead somewhere else.
 */
function gateNote(step: WorkflowCardStep, steps: WorkflowCardStep[]) {
  const gates = steps.some(
    (other) => other.effect && other.after.includes(step.id),
  );
  return element(
    "p",
    "workflow-card__gate",
    gates
      ? "You decide here. Nothing is written unless you approve."
      : "You decide here.",
  );
}

function stepItem(step: WorkflowCardStep, steps: WorkflowCardStep[]) {
  const item = element("li", "workflow-card__step");
  item.dataset.actor = step.actor;
  item.dataset.step = step.id;
  if (step.status) item.dataset.status = step.status;
  const head = element("div", "workflow-card__step-head");
  add(head, element("h4", undefined, step.title));
  if (step.who !== step.title)
    add(head, element("span", "workflow-card__who", step.who));
  if (step.status)
    add(
      head,
      element(
        "span",
        "workflow-card__status",
        STATUS_LABELS[step.status] ?? step.status,
      ),
    );
  add(item, head);
  if (step.description && step.description !== step.title)
    add(item, element("p", "workflow-card__description", step.description));
  const facts = element("dl", "workflow-card__details");
  const previous = steps[steps.indexOf(step) - 1];
  // A branch or join is spelled out; the usual chain is the list order itself.
  if (
    step.after.length &&
    !(step.after.length === 1 && step.after[0] === previous?.id)
  )
    add(
      facts,
      detail(
        "After",
        step.after.map(
          (id) => steps.find((other) => other.id === id)?.title ?? id,
        ),
      ),
    );
  if (step.reads.length) add(facts, detail("Uses", step.reads));
  if (step.produces.length) add(facts, detail("Produces", step.produces));
  if (step.needs.length) add(facts, detail("Needs", step.needs));
  if (facts.childElementCount) add(item, facts);
  if (step.review) add(item, gateNote(step, steps));
  return item;
}

/** What a draft needs before it could run; a run card shows its own state. */
function requirementsNote(model: WorkflowCardModel) {
  if (model.state.kind !== "draft" && model.state.kind !== "needs-connection")
    return;
  const needed = model.connections.filter((item) => item.state === "needed");
  return element(
    "p",
    "workflow-card__requirements",
    needed.length
      ? `Before this can run: connect ${needed.map((item) => item.label).join(" and ")}, then approve this draft.`
      : "Before this can run: approve this draft. Scheduling is not available yet.",
  );
}

function scheduleTrigger(schedule: string) {
  const trigger = element("li", "workflow-card__trigger");
  // Older saved cards contain the full schedule string. Compact them here too.
  const match = /^(.*) \(([A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*)\)$/.exec(schedule);
  const displaySchedule = (match?.[1] ?? schedule).replace(/\b(\d{1,2}):00(?=\s|$)/g, "$1");
  const text = displaySchedule;
  const chip = element("span", undefined, text);
  if (match) {
    chip.title = `Schedule timezone: ${match[2]}`;
    chip.setAttribute("aria-label", schedule);
    const zone = match[2];
    const city = zone.split("/").at(-1)?.replaceAll("_", " ") ?? zone;
    let label = city;
    try {
      const part = new Intl.DateTimeFormat("en-US", { timeZone: zone, timeZoneName: "shortGeneric" })
        .formatToParts(new Date()).find((item) => item.type === "timeZoneName")?.value;
      if (part && part.length <= 8 && !/^GMT[+-]/.test(part)) label = part;
    } catch { /* A legacy string may contain a zone this browser does not know. */ }
    const note = element("small", "workflow-card__timezone", label);
    note.title = zone;
    add(chip, note);
    add(trigger, chip);
  } else add(trigger, chip);
  return trigger;
}

function summaryFlow(model: WorkflowCardModel, compact: boolean, expanded: boolean) {
  // Compact chat previews summarize schedule/actions as a separate bulleted list;
  // full cards retain their ordered, chip-based summary presentation.
  const flow = element(compact ? "div" : "ol", "workflow-card__flow");
  flow.setAttribute("aria-label", "Summary of steps");
  const summary = compact ? element("ul", "workflow-card__summary") : flow;
  if (compact) summary.setAttribute("aria-label", "Schedule and actions");
  if (model.schedule) add(summary, scheduleTrigger(model.schedule));
  for (const step of compact ? chatSummarySteps(model.steps) : summarySteps(model.steps)) {
    const item = element("li");
    item.dataset.actor = step.actor;
    add(item, element("span", undefined, step.title));
    add(summary, item);
  }
  if (compact) add(flow, summary);
  const more = element("details", "workflow-card__graph");
  more.open = expanded;
  add(more, element("summary", undefined, "View workflow"));
  const steps = element("ol", "workflow-card__steps");
  steps.setAttribute("aria-label", "All steps, in order");
  for (const step of model.steps) add(steps, stepItem(step, model.steps));
  add(more, steps);
  if (compact) {
    add(flow, more);
  } else {
    const moreItem = element("li", "workflow-card__more-item");
    add(moreItem, more);
    add(flow, moreItem);
  }
  return { flow, more };
}

function connectionList(model: WorkflowCardModel, compact: boolean) {
  if (!model.connections.length) return null;
  const connections = element("ul", "workflow-card__connections");
  connections.setAttribute("aria-label", "Connections");
  for (const connection of model.connections) {
    const status = connection.state === "connected" ? "connected" : compact ? "needed to use this draft" : "needs connection";
    const item = element("li", undefined, `${connection.label}${compact ? " " : ": "}${status}`);
    item.dataset.state = connection.state;
    add(connections, item);
  }
  return connections;
}

/** A workflow card; `expanded` opens the full graph. */
export function renderWorkflowCard(
  model: WorkflowCardModel,
  options: { expanded?: boolean; headingLevel?: 2 | 3; compact?: boolean } = {},
) {
  const card = element("article", "workflow-card");
  card.dataset.workflow = model.id;
  card.dataset.state = model.state.kind;
  const heading = `workflow-card-${model.id}-${Math.random().toString(36).slice(2, 8)}`;
  card.setAttribute("aria-labelledby", heading);

  const state = element("p", "workflow-card__state", options.compact && model.state.kind === "needs-connection" ? "Draft · Not running" : model.state.label);
  const title = element(options.headingLevel === 2 ? "h2" : "h3");
  title.id = heading;
  title.textContent = model.title;
  add(card, state, title);
  if (model.benefit)
    add(card, element("p", "workflow-card__benefit", model.benefit));

  if (model.issues.length) {
    const issues = element("ul", "workflow-card__issues");
    issues.setAttribute("aria-label", "Validation problems");
    for (const issue of model.issues)
      add(issues, element("li", undefined, issue));
    add(card, issues);
    return card;
  }

  const { flow, more } = summaryFlow(model, Boolean(options.compact), Boolean(options.expanded));
  add(card, flow);

  const connections = connectionList(model, Boolean(options.compact));
  if (connections) add(card, connections);

  const requirements = requirementsNote(model);
  if (requirements) add(more, requirements);
  return card;
}
