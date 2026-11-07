import type {
  WikiAssertion,
} from "@ai-outfitter/app-sdk/wiki";
import type { Graph, GraphNode } from "../lib/graph";
import { call, el, link, notice } from "./data";

import type { AssertionInspection as Inspection } from "../lib/assertion-contract";
function subjectLink(reviewed: Inspection) {
  const { record, participants, types } = reviewed.subjectSnapshot;
  const list = el(
    "ul",
    {},
    ...participants.map((participant) =>
      el("li", {}, link(participant.title, participant.id, participant.typeId)),
    ),
  );
  const source =
    reviewed.assertion.subject.type === "graph-node"
      ? link(record.title ?? "Referenced record", record.id, record.typeId)
      : el(
          "p",
          {},
          types.find((t) => t.id === record.typeId)?.title ??
            "Referenced relationship",
        );
  return el(
    "div",
    {},
    source,
    participants.length ? list : null,
    el(
      "details",
      {},
      el("summary", {}, "Reviewed subject"),
      el("pre", {}, JSON.stringify(reviewed.subjectSnapshot, null, 2)),
    ),
  );
}

function evidenceList(assertion: WikiAssertion) {
  return el(
    "ul",
    {},
    ...assertion.evidence.map((evidence) =>
      el(
        "li",
        {},
        evidence.uri
          ? el(
              "a",
              {
                href: evidence.uri,
                target: "_blank",
                rel: "noopener noreferrer",
              },
              `${evidence.provider}: ${evidence.recordId}`,
            )
          : `${evidence.provider}: ${evidence.recordId}`,
        evidence.quote ? el("blockquote", {}, evidence.quote) : null,
      ),
    ),
  );
}
function render(
  section: HTMLElement,
  graph: Graph,
  node: GraphNode,
  reviewed: Inspection,
) {
  const { assertion } = reviewed;
  section.replaceChildren(
    el(
      "div",
      {},
      el("h2", {}, "Assertion and evidence"),
      el(
        "p",
        { role: "status" },
        reviewed.confirmed
          ? "Confirmed by a member for this assertion and subject."
          : "Not confirmed for the current assertion and subject.",
      ),
      el("p", {}, assertion.stance === "supports" ? "Supports:" : "Refutes:"),
      subjectLink(reviewed),
      el("p", {}, `Uncertainty: ${assertion.uncertainty.reason}`),
      assertion.uncertainty.confidence !== undefined
        ? el(
            "p",
            {},
            `Reported confidence: ${Math.round(assertion.uncertainty.confidence * 100)}%`,
          )
        : null,
      el("h3", {}, "Source evidence"),
      assertion.evidence.length
        ? evidenceList(assertion)
        : el("p", {}, "No source evidence supplied."),
      el(
        "p",
        {},
        `Reported provenance: ${assertion.provenance.method} at ${assertion.provenance.generatedAt}.`,
      ),
      el(
        "details",
        {},
        el("summary", {}, "Structured assertion"),
        el("pre", {}, JSON.stringify(assertion, null, 2)),
      ),
    ),
  );
  if (reviewed.confirmations.length)
    section.appendChild(
      el(
        "details",
        {},
        el("summary", {}, "Confirmation history"),
        el(
          "ul",
          {},
          ...reviewed.confirmations.map((receipt) =>
            el(
              "li",
              {},
              `Member ${receipt.userId} · ${receipt.confirmedAt} · assertion revision ${receipt.assertionRevision}`,
            ),
          ),
        ),
      ),
    );
  if (assertion.status === "withdrawn")
    section.appendChild(el("p", {}, "This assertion was withdrawn."));
  if (!reviewed.subjectCurrent)
    section.appendChild(
      el(
        "p",
        {},
        "The referenced record has changed. Update the assertion before confirming.",
      ),
    );
  if (
    !graph.canEdit ||
    node.archived ||
    reviewed.confirmed ||
    !reviewed.subjectCurrent ||
    assertion.status !== "proposed"
  )
    return;
  const confirm = el("button", { type: "button" }, "Confirm assertion");
  confirm.onclick = async () => {
    if (
      !window.confirm(
        "Confirm this assertion for the subject and evidence you reviewed?",
      )
    )
      return;
    confirm.disabled = true;
    try {
      const result = await call<Inspection>("assertions/confirm", {
        id: reviewed.id,
        revision: reviewed.revision,
        subjectHash: reviewed.subjectHash,
        affirm: true,
      });
      render(section, graph, node, result);
    } catch (error) {
      notice(error instanceof Error ? error.message : String(error));
      confirm.disabled = false;
    }
  };
  section.appendChild(confirm);
}
export function assertionReview(graph: Graph, node: GraphNode) {
  const section = el(
    "section",
    { class: "graph-section documentation" },
    el("h2", {}, "Assertion and evidence"),
    el("p", {}, "Loading review…"),
  );
  void call<Inspection>("assertions/inspect", {
    id: node.id,
    includeHistory: true,
  })
    .then((result) => render(section, graph, node, result))
    .catch((error) => {
      section.replaceChildren(
        el("h2", {}, "Assertion and evidence"),
        el(
          "p",
          {},
          error instanceof Error ? error.message : "Unable to load assertion.",
        ),
      );
    });
  return section;
}
