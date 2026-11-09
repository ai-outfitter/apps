// A small synthetic Wiki graph for the viewer (outfitter_whoami): one Person
// holding a Role, a Goal pursued by that Role and measured by a metric, and a
// control commitment the Role owns with one open and one closed obligation.
// Names follow catalog/apps/wiki-map/seeds (types-v1, control-pilot-types-v1).
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const viewerFixtureIds = { person: id(101), role: id(102) };
const node = (n, name, extra = {}) => ({ id: id(n), category: 'node', name, title: name, properties: [], ...extra });
const edge = (n, name, endpoints) => ({ id: id(n), category: 'edge', name, title: name, properties: [{ name: 'status', type: 'string' }], ...(endpoints ? { ontology: { version: 2, endpoints: { from: endpoints[0].map(id), to: endpoints[1].map(id) } } } : { ontology: { version: 2, endpoints: { from: "any", to: "any" } } }) });
/** A relator with its slots as [name, edge type, participant types], valid over an interval, as the seeds declare them. */
const relator = list => ({ ontology: { version: 2, stereotype: 'relator', validity: 'interval', participation: { slots: list.map(([name, edgeTypeId, participants]) => ({ name, edgeTypeId: id(edgeTypeId), participantTypes: participants.map(id), min: 1, max: 1 })) } } });
const types = [
  node(1, 'Person'), node(2, 'Role'), node(3, 'RoleAssignment', relator([['holder', 13, [1]], ['role', 14, [2]]])), node(4, 'Goal'), node(5, 'MetricDefinition'), node(6, 'ControlDefinition'), node(7, 'Organization'),
  node(8, 'ControlCommitment', relator([['owner', 21, [1, 2]], ['control', 22, [6]], ['subject', 23, [7]]])),
  node(9, 'ResponseObligation', relator([['commitment', 24, [8]]])),
  edge(11, 'pursues'), edge(12, 'measured_by'), edge(13, 'assigned_to', [[3], [1]]), edge(14, 'assigns_role', [[3], [2]]),
  edge(21, 'commitment_owner', [[8], [1, 2]]), edge(22, 'implements_control', [[8], [6]]), edge(23, 'commitment_subject', [[8], [7]]), edge(24, 'obligation_commitment', [[9], [8]]),
];
const slug = title => title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const record = (n, typeId, title, extra = {}) => ({ id: id(n), typeId: id(typeId), revision: 1, title, slug: slug(title), ...extra });
const link = (n, typeId, from, to, properties = {}) => ({ id: id(n), typeId: id(typeId), revision: 1, fromId: id(from), toId: id(to), properties });

/** The fixture Wiki's records; `owner` names the Wiki in its goal. */
export function viewerGraph(owner) {
  const nodes = [
    record(101, 1, 'Fixture Person'), record(102, 2, 'Reliability lead'), record(103, 3, 'Lead assignment', { validity: { from: '2026-01-01T00:00:00Z', to: null } }),
    record(104, 3, 'Ended assignment', { validity: { from: '2025-01-01T00:00:00Z', to: '2025-06-01T00:00:00Z' } }), record(105, 2, 'Former role'),
    record(106, 4, `Keep ${owner} reliable`), record(107, 4, 'Retired goal', { properties: { status: 'retired' } }), record(108, 5, 'Response time'),
    record(109, 6, 'Respond within eight hours'), record(110, 7, 'Fixture organization'), record(111, 8, 'Lead commitment', { properties: { state: 'active' } }),
    record(112, 9, 'Open obligation', { properties: { state: 'open' } }), record(113, 9, 'Closed obligation', { properties: { state: 'met' } }),
  ];
  const edges = [
    link(201, 13, 103, 101), link(202, 14, 103, 102), link(203, 13, 104, 101), link(204, 14, 104, 105),
    link(205, 11, 102, 106), link(206, 12, 106, 108, { status: 'observed' }),
    link(207, 21, 111, 102), link(208, 22, 111, 109), link(209, 23, 111, 110), link(210, 24, 112, 111), link(211, 24, 113, 111),
  ];
  return { nodes, edges, types };
}

/** The fixture plus `others` people, half holding the caller's role, each with an assignment and a commitment. */
export function crowdedViewerGraph(others) {
  const graph = viewerGraph('east');
  const id = n => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
  const type = name => String(graph.types.find(row => row.name === name)?.id);
  const node = (n, typeName, title, extra = {}) => ({ id: id(n), typeId: type(typeName), revision: 1, title, slug: slug(title), ...extra });
  const edge = (n, typeName, from, to) => ({ id: id(n), typeId: type(typeName), revision: 1, fromId: from, toId: to, properties: {} });
  const control = String(graph.nodes.find(row => row.title === 'Respond within eight hours')?.id);
  for (let at = 0; at < others; at++) {
    const base = 10 * at;
    graph.nodes.push(node(base + 1, 'Person', `Person ${at}`), node(base + 2, 'RoleAssignment', `Assignment ${at}`), node(base + 3, 'Role', `Role ${at}`), node(base + 4, 'ControlCommitment', `Commitment ${at}`, { properties: { state: 'active' } }));
    graph.edges.push(edge(base + 5, 'assigned_to', id(base + 2), id(base + 1)), edge(base + 6, 'assigns_role', id(base + 2), at % 2 ? id(base + 3) : viewerFixtureIds.role),
      edge(base + 7, 'commitment_owner', id(base + 4), id(base + 3)), edge(base + 8, 'implements_control', id(base + 4), control));
  }
  return graph;
}
