type Criterion = {
  ref: { installationId: string; type: string; id: string };
  revision: number;
  title: string;
  condition: string;
  expectedOutcome: string;
};
type Preview = {
  title: string;
  description: string;
  digest: string;
  criteria: Criterion[];
  gaps: string[];
};
type Destination = {
  installationId: string;
  projects: { id: string; name: string; ready?: boolean; blocker?: string }[];
};
type Governance = {
  installationId: string;
  controls: { id: string; title: string; revision: number }[];
};
type Check = {
  id?: string | number;
  name?: string;
  conclusion?: string;
  status?: string;
  html_url?: string;
  head_sha?: string;
};
type PullRequest = {
  number: number;
  url: string;
  repository: string;
  headSha: string;
  mergeSha?: string | null;
  merged: boolean;
  reviews: { id?: string | number; state?: string; body?: string; html_url?: string; commit_id?: string }[];
  checks: { check_runs: Check[] };
};
type WorkState = {
  submission: {
    id: string;
    title: string;
    snapshot: Preview;
    accepted: { execution?: WorkState["execution"] } | null;
    policy?: {
      accountableAssignment?: { roleTitle?: string; holderTitle?: string };
      recommenderAssignment?: { roleTitle?: string; holderTitle?: string };
    };
    review?: { occurrenceId?: string } | null;
  };
  freshness: { stale: boolean; blocker?: string };
  executionSource?: { source: "live" | "saved_observation" | "unavailable"; observedAt: number | null; currentLookupUnavailable: string | null };
  execution: {
    issue?: { url: string };
    pullRequests?: PullRequest[];
    run?: { status: string; url?: string };
    evidence?: { images?: { id?: string; url?: string; name?: string }[]; gaps?: string[] };
  } | null;
  evaluations: {
    criterion: { id: string };
    result: string;
    candidateCommit: string;
  }[];
  blockers: string[];
};

type ReadbackSummary = {
  summary: true;
  submission: { id: string; title: string; accepted: boolean };
  notice: string;
  readbackViews: string[];
  blockers?: string[];
};

const root = document.querySelector<HTMLElement>("#planning-execution");
if (import.meta.env.OUTFITTER_APP_MODE === "operational") {
  if (root) initialize(root);
} else if (root) {
  const status = root.querySelector<HTMLElement>("#execution-status");
  if (status) status.textContent = "Read-only demo. Work submission and acceptance require an operational installation.";
}

function append(parent: Node, ...children: Node[]) {
  for (const child of children) parent.appendChild(child);
}

function initialize(container: HTMLElement) {
  const projectId = container.dataset.projectId;
  if (!projectId) throw new Error("Project context is missing");
  const element = <T = HTMLElement>(id: string): T => {
    const match = container.querySelector(`#${id}`);
    if (!match) throw new Error(`Missing work control: ${id}`);
    return match as unknown as T;
  };
  const status = element<HTMLParagraphElement>("execution-status");
  const form = element<HTMLFormElement>("execution-form");
  const saved = element<HTMLSelectElement>("execution-saved");
  const confirm = element<HTMLInputElement>("execution-confirm");
  const submit = element<HTMLButtonElement>("execution-submit");
  let preview: Preview | undefined;
  let requestId = crypto.randomUUID();
  let state: WorkState | undefined;
  const field = (name: string) =>
    form.elements.namedItem(name) as unknown as HTMLSelectElement;
  const message = (text: string) => {
    status.textContent = text;
  };
  const report = (error: unknown) =>
    message(
      error instanceof Error
        ? error.message
        : "The request could not be completed. Your saved package is unchanged.",
    );

  async function action<T>(name: string, input: unknown): Promise<T> {
    const response = await fetch("/api/apps/planning/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: name, input }),
    });
    if (!response.ok) throw new Error(await response.text());
    return response.json();
  }
  function option(
    select: HTMLSelectElement,
    value: string,
    text: string,
    disabled = false,
  ) {
    const node = document.createElement("option");
    node.value = value;
    node.textContent = text;
    node.disabled = disabled;
    select.appendChild(node);
  }
  function text(
    parent: HTMLElement,
    tag: "p" | "h3" | "h4" | "li" | "summary",
    content: string,
  ) {
    const node = document.createElement(tag);
    node.textContent = content;
    parent.appendChild(node);
    return node;
  }
  function link(parent: HTMLElement, label: string, value: string | undefined) {
    if (!value) return;
    try {
      const url = new URL(value, window.location.href);
      if (url.protocol !== "https:" && url.origin !== window.location.origin)
        return;
      const node = document.createElement("a");
      node.href = url.href;
      node.textContent = label;
      node.rel = "noopener noreferrer";
      parent.appendChild(node);
    } catch {
      /* An unavailable evidence link remains absent. */
    }
  }
  function allowSubmit() {
    submit.disabled =
      !preview ||
      !!preview.gaps.length ||
      !confirm.checked ||
      !field("destination").value ||
      !field("policy").value;
  }
  function previewInput() {
    return {
      projectId,
      issueId: field("issueId").value || undefined,
      definitionId: field("definitionId").value || undefined,
    };
  }
  async function summaries(selected?: string) {
    const records = await action<{ id: string; title: string }[]>(
      "work.submissions",
      { projectId },
    );
    saved.replaceChildren();
    option(saved, "", "Choose submitted work");
    for (const item of records) option(saved, item.id, item.title);
    if (selected) saved.value = selected;
  }
  function invalidate() {
    preview = undefined;
    confirm.checked = false;
    element("execution-preview").hidden = true;
    requestId = crypto.randomUUID();
    allowSubmit();
  }
  form.addEventListener("change", invalidate);
  confirm.addEventListener("change", allowSubmit);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    try {
      preview = await action<Preview>("work.preview", previewInput());
      requestId = crypto.randomUUID();
      confirm.checked = false;
      element("execution-preview-body").textContent = preview.description;
      const criteria = element("execution-preview-criteria");
      criteria.replaceChildren();
      for (const criterion of preview.criteria)
        text(
          criteria,
          "li",
          `${criterion.title}: ${criterion.expectedOutcome}`,
        );
      element("execution-preview-gaps").textContent = preview.gaps.join("; ");
      element("execution-preview").hidden = false;
      allowSubmit();
      message(
        "Preview ready. Review the scope and criteria before submission.",
      );
    } catch (error) {
      report(error);
    }
  });
  submit.addEventListener("click", async () => {
    if (!preview || !confirm.checked || submit.disabled) return;
    submit.disabled = true;
    try {
      const destination = JSON.parse(field("destination").value) as {
        installationId: string;
        projectId: string;
      };
      const policy = JSON.parse(field("policy").value) as {
        installationId: string;
        controlId: string;
      };
      const result = await action<WorkState>("work.submit", {
        requestId,
        preview: previewInput(),
        expectedDigest: preview.digest,
        foundryInstallationId: destination.installationId,
        foundryProjectId: destination.projectId,
        governanceInstallationId: policy.installationId,
        controlId: policy.controlId,
      });
      await summaries(result.submission.id);
      render(result);
      message(
        "Submitted to Foundry. The reviewed package is saved with this work.",
      );
    } catch (error) {
      report(error);
      allowSubmit();
    }
  });

  function evaluationForm(
    parent: HTMLElement,
    criterion: Criterion,
    commit: string,
    checks: Check[],
    reviews: PullRequest["reviews"],
  ) {
    const submissionId = state?.submission.id;
    if (!submissionId) return;
    const editor = document.createElement("form");
    text(editor, "h4", criterion.title);
    text(editor, "p", `${criterion.condition} ${criterion.expectedOutcome}`);
    const prior = state?.evaluations
      .filter(
        (x) =>
          x.criterion.id === criterion.ref.id && x.candidateCommit === commit,
      )
      .at(-1);
    text(editor, "p", `Recorded result: ${prior?.result ?? "Not evaluated"}`);
    const result = document.createElement("select");
    result.setAttribute("aria-label", `Result for ${criterion.title}`);
    for (const value of ["not_run", "passed", "failed", "blocked"])
      option(result, value, value.replace("_", " "));
    const method = document.createElement("textarea");
    method.required = true;
    method.maxLength = 2000;
    method.placeholder =
      "Describe what was checked and how the evidence supports this criterion";
    method.setAttribute(
      "aria-label",
      `Evaluation method for ${criterion.title}`,
    );
    const evidence = document.createElement("select");
    evidence.multiple = true;
    evidence.setAttribute("aria-label", `Evidence for ${criterion.title}`);
    evidenceOptions(evidence, checks, reviews);
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "ui-button ui-button--secondary";
    button.textContent = "Record evaluation";
    append(editor, result, method, evidence, button);
    editor.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        await action("work.evaluate", {
          submissionId,
          criterion: criterion.ref,
          criterionRevision: criterion.revision,
          candidateCommit: commit,
          result: result.value,
          method: method.value,
          evidence: [...evidence.selectedOptions].map((x) =>
            JSON.parse(x.value),
          ),
        });
        await refresh();
        message(
          "Evaluation recorded. Acceptance still requires the applicable governance decision.",
        );
      } catch (error) {
        report(error);
      } finally {
        button.disabled = false;
      }
    });
    parent.appendChild(editor);
  }
  function evidenceOptions(
    select: HTMLSelectElement,
    checks: Check[],
    reviews: PullRequest["reviews"],
  ) {
    for (const check of checks)
      if (check.id !== undefined)
        option(
          select,
          JSON.stringify({ kind: "check", id: String(check.id) }),
          `${check.name ?? "Check"}: ${check.conclusion ?? check.status ?? "unknown"}`,
        );
    for (const review of reviews)
      if (review.id !== undefined)
        option(
          select,
          JSON.stringify({ kind: "review", id: String(review.id) }),
          `Review: ${review.state ?? "unknown"}`,
        );
  }
  function reviewForm(parent: HTMLElement, commit: string) {
    const submissionId = state?.submission.id;
    if (!submissionId) return;
    const editor = document.createElement("form");
    const recommendation = document.createElement("textarea");
    recommendation.required = true;
    recommendation.maxLength = 2500;
    recommendation.setAttribute("aria-label", "Acceptance recommendation");
    recommendation.placeholder =
      "Explain why the completed work meets the agreed criteria";
    const button = document.createElement("button");
    button.type = "submit";
    button.className = "ui-button ui-button--secondary";
    button.textContent = "Request acceptance review";
    append(editor, recommendation, button);
    editor.addEventListener("submit", async (event) => {
      event.preventDefault();
      button.disabled = true;
      try {
        const reviewed = await action<WorkState & { reviewNotice?: string }>("work.request-review", {
          submissionId,
          candidateCommit: commit,
          recommendation: recommendation.value,
        });
        render(reviewed);
        message(
          reviewed.reviewNotice ?? "Acceptance review requested. Complete the assigned recommendation and decision in Governance.",
        );
      } catch (error) {
        report(error);
      } finally {
        button.disabled = false;
      }
    });
    parent.appendChild(editor);
    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = "ui-button";
    accept.textContent = "Check decision and accept work";
    accept.addEventListener("click", async () => {
      accept.disabled = true;
      try {
        render(
          await action<WorkState>("work.accept", {
            submissionId,
            candidateCommit: commit,
          }),
        );
        message(
          "Work accepted against its agreed criteria and governance decision.",
        );
      } catch (error) {
        report(error);
      } finally {
        accept.disabled = false;
      }
    });
    parent.appendChild(accept);
  }
  function render(value: WorkState | ReadbackSummary) {
    if ("summary" in value) return renderSummary(value);
    state = value;
    const result = element("execution-result");
    result.replaceChildren();
    text(result, "h3", value.submission.title);
    text(
      result,
      "p",
      value.submission.accepted
        ? "Accepted. Deployment is recorded separately."
        : "Not accepted.",
    );
    if (value.freshness.stale)
      text(
        result,
        "p",
        "Source context changed. Reassess this work before acceptance.",
      );
    for (const blocker of new Set([
      ...value.blockers,
      ...(value.freshness.blocker ? [value.freshness.blocker] : []),
    ]))
      text(result, "p", blocker);
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Original submitted package";
    const original = document.createElement("pre");
    original.className = "work-description";
    original.textContent = value.submission.snapshot.description;
    append(details, summary, original);
    result.appendChild(details);
    evidenceFreshness(result, value.executionSource);
    executionLinks(result, value.execution);
    acceptedEvidence(result, value.submission.accepted);
    policyDetails(result, value.submission);
    acceptanceForms(result, value);
  }
  function renderSummary(value: ReadbackSummary) {
    state = undefined;
    const result = element("execution-result");
    result.replaceChildren();
    text(result, "h3", value.submission.title);
    text(result, "p", value.submission.accepted ? "Accepted. Deployment is recorded separately." : "Not accepted.");
    text(result, "p", "This work package has more detail than one page can load. Open its saved sections separately.");
    for (const blocker of new Set(value.blockers ?? [])) text(result, "p", blocker);
    const content = document.createElement("section");
    const views = { snapshot: "Submitted scope", evidence: "Current evidence", acceptance: "Acceptance record", evaluations: "Recorded evaluations" };
    for (const [view, label] of Object.entries(views)) {
      if (!value.readbackViews.includes(view)) continue;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ui-button ui-button--secondary";
      button.textContent = label;
      button.addEventListener("click", async () => {
        button.disabled = true;
        try {
          const section = await action<unknown>("work.get", { submissionId: value.submission.id, view });
          renderSection(content, view, section);
        } catch (error) { report(error); }
        finally { button.disabled = false; }
      });
      result.appendChild(button);
    }
    result.appendChild(content);
  }
  function renderSection(parent: HTMLElement, view: string, section: unknown) {
    parent.replaceChildren();
    switch (view) {
      case "snapshot": return renderSnapshot(parent, section as Preview);
      case "evidence": {
        const evidence = section as Pick<WorkState, "execution" | "executionSource">;
        evidenceFreshness(parent, evidence.executionSource);
        return executionLinks(parent, evidence.execution);
      }
      case "acceptance": return renderAcceptance(parent, section as WorkState["submission"]["accepted"]);
      case "evaluations": return renderEvaluations(parent, section as WorkState["evaluations"]);
    }
  }
  function renderSnapshot(parent: HTMLElement, snapshot: Preview) {
    text(parent, "h3", snapshot.title);
    const brief = document.createElement("pre");
    brief.className = "work-description";
    brief.textContent = snapshot.description;
    parent.appendChild(brief);
    for (const criterion of snapshot.criteria) text(parent, "p", `${criterion.title} (revision ${criterion.revision}): ${criterion.condition} ${criterion.expectedOutcome}`);
  }
  function renderAcceptance(parent: HTMLElement, accepted: WorkState["submission"]["accepted"]) {
    text(parent, "p", accepted ? "Acceptance recorded. Deployment is recorded separately." : "Not accepted.");
    if (accepted?.execution) executionLinks(parent, accepted.execution);
  }
  function renderEvaluations(parent: HTMLElement, evaluations: (WorkState["evaluations"][number] & { method?: string })[]) {
    if (!evaluations.length) text(parent, "p", "No evaluations recorded for this candidate.");
    for (const evaluation of evaluations) text(parent, "p", `Criterion ${evaluation.criterion.id}: ${evaluation.result}. Commit: ${evaluation.candidateCommit}. ${evaluation.method ?? ""}`);
  }
  function acceptedEvidence(parent: HTMLElement, accepted: WorkState["submission"]["accepted"]) {
    if (!accepted?.execution) return;
    const details = document.createElement("details");
    text(details, "summary", "Evidence recorded at acceptance");
    executionLinks(details, accepted.execution);
    parent.appendChild(details);
  }
  function evidenceFreshness(result: HTMLElement, source: WorkState["executionSource"]) {
    if (source?.source === "saved_observation") {
      const observedAt = source.observedAt;
      text(result, "p", `Saved evidence${observedAt ? ` observed ${new Date(observedAt).toLocaleString()}` : ""}. Current provider state has not been verified.`);
    }
    if (source?.currentLookupUnavailable) text(result, "p", source.currentLookupUnavailable);
  }
  function policyDetails(
    parent: HTMLElement,
    submission: WorkState["submission"],
  ) {
    const accountable = submission.policy?.accountableAssignment;
    if (accountable?.holderTitle)
      text(
        parent,
        "p",
        `Accountable: ${accountable.holderTitle} (${accountable.roleTitle ?? "Assigned decision role"}).`,
      );
    const recommender = submission.policy?.recommenderAssignment;
    if (recommender?.holderTitle)
      text(
        parent,
        "p",
        `Acceptance recommendation: ${recommender.holderTitle} (${recommender.roleTitle ?? "Assigned recommender"}).`,
      );
    if (!submission.review) return;
    const mount = /^\/o\/([^/]+)\//.exec(window.location.pathname);
    if (mount)
      link(
        parent,
        "Continue the assigned review in Governance",
        `/o/${mount[1]}/governance/`,
      );
  }
  function executionLinks(
    result: HTMLElement,
    execution: WorkState["execution"],
  ) {
    link(result, "External issue", execution?.issue?.url);
    text(
      result,
      "p",
      `Execution: ${execution?.run?.status ?? "Result unavailable"}`,
    );
    link(result, "Foundry execution", execution?.run?.url);
    for (const pr of execution?.pullRequests ?? []) pullRequestEvidence(result, pr);
    for (const gap of execution?.evidence?.gaps ?? []) text(result, "p", `Evidence unavailable: ${gap}`);
    for (const image of execution?.evidence?.images ?? []) {
      const row = text(result, "p", "Evidence · ");
      link(row, image.name ?? "View image", image.url);
    }
  }
  function pullRequestEvidence(result: HTMLElement, pr: PullRequest) {
      const row = text(result, "p", `${pr.merged ? "Merged" : "Open"} · `);
      link(row, `${pr.repository} #${pr.number}`, pr.url);
      text(result, "p", `Reviewed head: ${pr.headSha}. Merge commit: ${pr.mergeSha ?? "Not merged"}.`);
      const evidence = document.createElement("details");
      text(evidence, "summary", "Reviews and checks");
      if (!pr.reviews.length) text(evidence, "p", "No review evidence returned.");
      for (const review of pr.reviews) {
        const entry = text(evidence, "p", `Review ${review.id ?? ""}: ${review.state ?? "Unknown"} `);
        link(entry, "View review", review.html_url);
      }
      if (!pr.checks.check_runs.length) text(evidence, "p", "No check evidence returned.");
      for (const check of pr.checks.check_runs) {
        const entry = text(evidence, "p", `${check.name ?? "Check"}: ${check.conclusion ?? check.status ?? "Unknown"} `);
        link(entry, "View check", check.html_url);
      }
      result.appendChild(evidence);
  }
  function acceptanceForms(result: HTMLElement, value: WorkState) {
    if (value.submission.accepted || value.freshness.stale) return;
    const merged = value.execution?.pullRequests?.find(
      (x) => x.merged && x.mergeSha,
    );
    if (!merged?.mergeSha) {
      text(
        result,
        "p",
        "Acceptance is available after Foundry returns a merged candidate and its evidence.",
      );
      return;
    }
    text(result, "h3", "Evaluate agreed criteria");
    for (const criterion of value.submission.snapshot.criteria)
      evaluationForm(
        result,
        criterion,
        merged.headSha,
        merged.checks.check_runs.filter((check) => check.head_sha === merged.headSha),
        merged.reviews.filter((review) => review.commit_id === merged.headSha),
      );
    text(result, "h3", "Acceptance decision");
    reviewForm(result, merged.headSha);
  }
  async function refresh(observe = false) {
    if (saved.value)
      render(
        await action<WorkState>(observe ? "work.refresh" : "work.get", {
          submissionId: saved.value,
        }),
      );
  }
  saved.addEventListener("change", () => {
    void refresh().catch(report);
  });
  element("execution-refresh").addEventListener("click", () => {
    void refresh(true).catch(report);
  });

  function destinationOptions(destinations: {
    foundries: Destination[];
    governances: Governance[];
  }) {
    option(field("destination"), "", "Choose a Foundry project");
    for (const foundry of destinations.foundries)
      for (const project of foundry.projects)
        option(
          field("destination"),
          JSON.stringify({
            installationId: foundry.installationId,
            projectId: project.id,
          }),
          project.name,
          project.ready === false,
        );
    option(field("policy"), "", "Choose an active acceptance policy");
    for (const governance of destinations.governances)
      for (const control of governance.controls)
        option(
          field("policy"),
          JSON.stringify({
            installationId: governance.installationId,
            controlId: control.id,
          }),
          control.title,
        );
  }

  async function load() {
    if (container.dataset.demo === "true") {
      message(
        "Read-only demo. Work submission and acceptance require an operational installation.",
      );
      return;
    }
    const [context, destinations, response] = await Promise.all([
      action<{
        project: { title: string };
        definitions: { ref: { id: string }; title: string }[];
      }>("project.context", { projectId }),
      action<{ foundries: Destination[]; governances: Governance[] }>(
        "work.destinations",
        {},
      ),
      fetch("/api/apps/planning"),
    ]);
    if (!response.ok) throw new Error("Project issues are unavailable.");
    const planning = (await response.json()) as {
      issues: { id: string; projectId: string; title: string }[];
    };
    for (const issue of planning.issues.filter(
      (x) => x.projectId === projectId,
    ))
      option(field("issueId"), issue.id, issue.title);
    for (const definition of context.definitions)
      option(field("definitionId"), definition.ref.id, definition.title);
    destinationOptions(destinations);
    form.hidden = false;
    await summaries();
    message(
      destinations.foundries.length &&
        destinations.governances.some((x) => x.controls.length)
        ? `Prepare work for ${context.project.title}.`
        : "Preview is available. Configure a Foundry project and active Governance policy before submitting work.",
    );
  }
  void load().catch(report);
}
