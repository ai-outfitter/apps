type Entry = Record<string, unknown>;
type Names = Record<string, string>;
type Evidence = { evidence: string[]; required?: string[] };
type Expected = {
  nodes: ({ key: string; name: string } & Evidence)[];
  edges: ({ key: string; from: string; to: string } & Evidence)[];
  decisions: Record<string, { action: string } & Evidence>;
};

const isObject = (value: unknown): value is Entry => value !== null && typeof value === 'object' && !Array.isArray(value);
const grounded = (row: Entry | undefined, { evidence, required = [] }: Evidence) => {
  if (!Array.isArray(row?.evidence) || !row.evidence.length) return false;
  const ids = row.evidence as string[];
  return new Set(ids).size === ids.length && ids.every(id => evidence.includes(id)) && required.every(id => ids.includes(id));
};

/** The independent rubric is read by the scorer, never included in inference. */
export function gradeProposal(output: string, names: Names, expected: Expected, existing: string[]) {
  let proposal: unknown;
  try { proposal = JSON.parse(output); } catch { /* Invalid JSON is a failed submission. */ }
  const shape = isObject(proposal) && ['nodes', 'edges', 'decisions'].every(
    key => Array.isArray(proposal[key]) && (proposal[key] as unknown[]).every(isObject),
  );
  const { nodes, edges, decisions } = shape
    ? proposal as { nodes: Entry[]; edges: Entry[]; decisions: Entry[] }
    : { nodes: [], edges: [], decisions: [] };
  const unique = (rows: Entry[], predicate: (entry: Entry) => boolean) => {
    const matches = rows.filter(predicate);
    return matches.length === 1 ? matches[0] : undefined;
  };
  const matched = Object.fromEntries(expected.nodes.map(({key, name}) =>
    [key, unique(nodes, node => node.name === name && node.type === names[key])]));
  const resolve = (end: string) => end.startsWith('$') ? matched[end.slice(1)]?.id : end;
  const links = expected.edges.map((spec) => {
    const from = resolve(spec.from);
    const to = resolve(spec.to);
    const row = unique(edges, edge => edge.type === names[spec.key]);
    return { ...spec, row, directed: typeof from === 'string' && typeof to === 'string' && row?.from === from && row.to === to };
  });
  const decisionRows = Object.entries(expected.decisions).map(([key, spec]) =>
    ({ key, spec, row: unique(decisions, decision => decision.question === key) }));
  const ids = Object.values(matched).map(node => node?.id);
  const validHandles = ids.every(id => typeof id === 'string' && id.trim().length > 0 && !existing.includes(id));
  const checks = {
    grounding: {
      ...Object.fromEntries(expected.nodes.map(spec => [spec.key, grounded(matched[spec.key], spec)])),
      ...Object.fromEntries(links.map(link => [link.key, grounded(link.row, link)])),
    },
    canonicalReuse: {
      onlyNewRecords: nodes.length === ids.length && validHandles && new Set(ids).size === ids.length,
      verifiedPerson: links.filter(link => link.from === 'g-101').every(link => link.row?.from === 'g-101'),
      sharedOperatorPublisher: links.filter(link => link.to === 'g-227').every(link => link.row?.to === 'g-227'),
      ...Object.fromEntries(links.filter(link => link.to === 'g-380').map(link => [link.key, link.row?.to === link.to])),
    },
    directedRelationships: {
      ...Object.fromEntries(links.map(link => [link.key, link.directed])),
      onlySupportedEdges: edges.length === links.length && links.every(link => !!link.row),
    },
    decisionEvidence: {
      ...Object.fromEntries(decisionRows.map(({ key, spec, row }) =>
        [key, row?.action === spec.action && grounded(row, spec) && typeof row.reason === 'string' && row.reason.trim().length > 0])),
      onlyRequestedDecisions: decisions.length === decisionRows.length && decisionRows.every(({row}) => !!row),
    },
  };
  const scores = Object.fromEntries(Object.entries(checks).map(([name, group]) => {
    const values = Object.values(group);
    return [name, { passed: values.filter(Boolean).length, total: values.length }];
  }));
  return { passed: shape && Object.values(scores).every(({passed, total}) => passed === total), validShape: shape, checks, scores };
}
