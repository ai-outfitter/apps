import { core } from "../../src/lib/graph";
const id = (n: number) =>
  `72000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const ids = {
  marriage: id(1),
  spouse: id(2),
  spouseOf: id(3),
  friend: id(4),
  assertion: id(5),
  assignment: id(6),
  holder: id(7),
  role: id(8),
  scope: id(9),
  approver: id(10),
  alex: id(20),
  cristina: id(21),
  nicholas: id(22),
  organization: id(23),
  roleNode: id(24),
  product: id(25),
  union: id(30),
  firstSpouse: id(31),
  secondSpouse: id(32),
  claim: id(33),
  friendEdge: id(34),
  assignmentNode: id(35),
};
export const create = (ref: string, type: string, attributes: object) => ({
  operation: "create",
  ref,
  type,
  attributes,
});
export const update = (
  ref: string,
  type: string,
  id: string,
  revision: number,
  attributes: object,
) => ({ operation: "update", ref, type, id, revision, attributes });
const edgeType = (ref: string, id: string, name: string, ontology?: object) =>
  create(ref, "graph-type", {
    id,
    name,
    title: name.replace(/^test_/, "").replaceAll("_", " "),
    category: "edge",
    body: "Synthetic relationship definition.",
    ...(ontology ? { ontology } : {}),
  });
export function definitions() {
  return [
    create("$marriageType", "graph-type", {
      id: ids.marriage,
      category: "node",
      name: "TestMarriage",
      title: "Marriage",
      body: "Synthetic marriage relator.",
      ontology: {
        version: 2,
        stereotype: "relator",
        validity: "interval",
        participation: {
          slots: [
            {
              name: "spouse",
              edgeTypeId: ids.spouse,
              participantTypes: [core.person],
              min: 2,
              max: 2,
            },
          ],
          distinct: [["spouse"]],
          uniqueBy: ["spouse"],
        },
      },
    }),
    edgeType("$spouseType", ids.spouse, "test_spouse", {
      version: 2,
      endpoints: { from: [ids.marriage], to: [core.person] },
    }),
    edgeType("$spouseView", ids.spouseOf, "test_spouse_of", {
      version: 2,
      projection: {
        relatorTypeId: ids.marriage,
        fromSlot: "spouse",
        toSlot: "spouse",
        symmetric: true,
      },
    }),
    edgeType("$friendType", ids.friend, "test_friends_with", {
      version: 2,
      endpoints: { from: [core.person], to: [core.person] },
      symmetric: true,
      validity: "interval",
    }),
    create("$assertionType", "graph-type", {
      id: ids.assertion,
      category: "node",
      name: "TestAssertion",
      title: "Assertion",
      body: "Synthetic assertion payload.",
      ontology: { version: 2, stereotype: "assertion" },
    }),
    create("$assignmentType", "graph-type", {
      id: ids.assignment,
      category: "node",
      name: "TestAssignment",
      title: "Assignment",
      body: "Synthetic scoped role assignment.",
      ontology: {
        version: 2,
        stereotype: "relator",
        participation: {
          slots: [
            {
              name: "holder",
              edgeTypeId: ids.holder,
              participantTypes: [core.person],
              min: 1,
              max: 1,
            },
            {
              name: "role",
              edgeTypeId: ids.role,
              participantTypes: [core.role],
              min: 1,
              max: 1,
            },
            {
              name: "scope",
              edgeTypeId: ids.scope,
              participantTypes: [core.organization],
              min: 1,
              max: 1,
            },
            {
              name: "approver",
              edgeTypeId: ids.approver,
              participantTypes: [core.person],
              min: 0,
              max: 1,
            },
          ],
          distinct: [["holder", "approver"]],
          uniqueBy: ["holder", "role", "scope"],
        },
      },
    }),
    edgeType("$holderType", ids.holder, "test_holder", { version: 2, endpoints: { from: [ids.assignment], to: [core.person] } }),
    edgeType("$roleType", ids.role, "test_role", { version: 2, endpoints: { from: [ids.assignment], to: [core.role] } }),
    edgeType("$scopeType", ids.scope, "test_scope", { version: 2, endpoints: { from: [ids.assignment], to: [core.organization] } }),
    edgeType("$approverType", ids.approver, "test_approver", { version: 2, endpoints: { from: [ids.assignment], to: [core.person] } }),
  ];
}
export const people = () => [
  create("$alex", "graph-node", {
    id: ids.alex,
    typeId: core.person,
    title: "Alex",
    slug: "test-alex",
  }),
  create("$cristina", "graph-node", {
    id: ids.cristina,
    typeId: core.person,
    title: "Cristina",
    slug: "test-cristina",
  }),
  create("$nicholas", "graph-node", {
    id: ids.nicholas,
    typeId: core.person,
    title: "Nicholas",
    slug: "test-nicholas",
  }),
  create("$organization", "graph-node", {
    id: ids.organization,
    typeId: core.organization,
    title: "Example Org",
    slug: "test-organization",
  }),
  create("$role", "graph-node", {
    id: ids.roleNode,
    typeId: core.role,
    title: "Example Role",
    slug: "test-role",
  }),
  create("$product", "graph-node", {
    id: ids.product,
    typeId: core.product,
    title: "Example Product",
    slug: "test-product",
  }),
];
export const marriage = () => [
  create("$marriage", "graph-node", {
    id: ids.union,
    typeId: "$marriageType",
    title: "Synthetic marriage",
    slug: "test-marriage",
    validity: { from: "2026-01-01T00:00:00Z", to: null },
  }),
  create("$spouse1", "graph-edge", {
    id: ids.firstSpouse,
    typeId: "$spouseType",
    fromId: "$marriage",
    toId: "$alex",
  }),
  create("$spouse2", "graph-edge", {
    id: ids.secondSpouse,
    typeId: "$spouseType",
    fromId: "$marriage",
    toId: "$cristina",
  }),
];
export const claimBody = (id = ids.union, revision = 1) => ({
  schemaVersion: 1,
  subject: { type: "graph-node", id, revision },
  stance: "supports",
  status: "proposed",
  uncertainty: {
    confidence: 0.6,
    reason:
      "Synthetic claim awaiting explicit review; a calendar title alone establishes no marriage.",
  },
  evidence: [
    {
      provider: "calendar",
      recordId: "synthetic-event",
      quote: "Cristina/Alex",
      observedAt: "2026-01-01T00:00:00Z",
    },
  ],
  provenance: {
    method: "inference",
    agentId: "synthetic-agent",
    runId: "synthetic-run",
    generatedAt: "2026-01-01T00:00:00Z",
  },
});
