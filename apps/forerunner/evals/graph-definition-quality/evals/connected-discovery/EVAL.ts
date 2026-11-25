type Entry = Record<string, unknown>;
type Names = Record<string, string>;
const isObject = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value);
const citesOnly = (record: Entry | undefined, ...ids: string[]) =>
  Array.isArray(record?.evidence) && ids.length === record.evidence.length && ids.every((id) => (record.evidence as string[]).includes(id));

/** Grade independently of the inference context. The scorer never enters a model message. */
export function gradeProposal(output: string, names: Names) {
  let proposal: unknown;
  try { proposal = JSON.parse(output); } catch { /* Invalid JSON is a failed submission. */ }
  const shape = isObject(proposal) && ['nodes', 'edges', 'decisions'].every(
    (key) => Array.isArray(proposal[key]) && (proposal[key] as unknown[]).every(isObject),
  );
  const { nodes, edges, decisions } = shape
    ? proposal as { nodes: Entry[]; edges: Entry[]; decisions: Entry[] }
    : { nodes: [], edges: [], decisions: [] };
  const unique = (rows: Entry[], predicate: (entry: Entry) => boolean) => {
    const matches = rows.filter(predicate);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const product = unique(nodes, ({ name, type }) => name === 'Tideglass Desk' && type === names.product);
  const publication = unique(nodes, ({ name, type }) => name === 'Tideglass Dispatch' && type === names.newsletter);
  const relationship = (type: string) => unique(edges, (row) => row.type === type);
  const signIn = relationship(names.sign_in);
  const operator = relationship(names.operator);
  const recipient = relationship(names.recipient);
  const publisher = relationship(names.publisher);
  const use = unique(decisions, ({ question }) => question === 'product_use');
  const developer = unique(decisions, ({ question }) => question === 'product_developer');
  const hasReason = (decision: Entry | undefined) => typeof decision?.reason === 'string' && decision.reason.trim().length > 0;
  const newHandle = (node: Entry | undefined) =>
    typeof node?.id === 'string' && node.id.trim().length > 0 && !['g-101', 'g-227', 'g-537', 'g-280'].includes(node.id);
  const exactConnection = (edge: Entry | undefined, from: unknown, to: unknown) =>
    typeof from === 'string' && typeof to === 'string' && edge?.from === from && edge.to === to;
  const checks = {
    grounding: {
      product: citesOnly(product, 'E1') || citesOnly(product, 'E2') || citesOnly(product, 'E1', 'E2'),
      publication: citesOnly(publication, 'E3'),
      signIn: citesOnly(signIn, 'E1'),
      operator: citesOnly(operator, 'E2'),
      recipient: citesOnly(recipient, 'E3'),
      publisher: citesOnly(publisher, 'E3'),
    },
    canonicalReuse: {
      onlyNewRecords: nodes.length === 2 && newHandle(product) && newHandle(publication) && product?.id !== publication?.id,
      verifiedPerson: signIn?.from === 'g-101' && recipient?.from === 'g-101',
      sameRegisteredOrganization: operator?.to === 'g-227' && publisher?.to === 'g-227',
    },
    directedRelationships: {
      signIn: exactConnection(signIn, 'g-101', product?.id),
      operator: exactConnection(operator, product?.id, 'g-227'),
      recipient: exactConnection(recipient, 'g-101', publication?.id),
      publisher: exactConnection(publisher, publication?.id, 'g-227'),
      onlySupportedEdges: edges.length === 4 && !!(signIn && operator && recipient && publisher),
    },
    decisionEvidence: {
      use: use?.action === 'defer' && citesOnly(use, 'E1', 'E4') && hasReason(use),
      developer: developer?.action === 'defer' &&
        (citesOnly(developer, 'E2') || citesOnly(developer, 'E2', 'E4')) && hasReason(developer),
      onlyRequestedDecisions: decisions.length === 2 && !!(use && developer),
    },
  };
  const scores = Object.fromEntries(Object.entries(checks).map(([name, group]) => {
    const values = Object.values(group);
    return [name, { passed: values.filter(Boolean).length, total: values.length }];
  }));
  return {
    passed: shape && Object.values(scores).every(({ passed, total }) => passed === total),
    validShape: shape,
    checks,
    scores,
  };
}
