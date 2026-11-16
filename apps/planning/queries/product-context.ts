export const productContextQuery = `query ProductContext($root: ID!, $after: String) {
  organization(id: $root) {
    id title slug revision
    developed: edges(types: ["developed_by"], direction: INCOMING, first: 500) { nodes { properties from { ...ProductContextCard } } pageInfo { hasNextPage } }
    offerings: edges(types: ["offered_by"], direction: INCOMING, first: 500) { nodes {
      from { ... on Offering { products: edges(types: ["packages_product"], direction: OUTGOING, first: 500) { nodes { to { ...ProductContextCard } } pageInfo { hasNextPage } } } }
    } pageInfo { hasNextPage } }
    projects: edges(types: ["part_of"], direction: INCOMING, first: 500) { nodes {
      from { ... on Project { products: edges(types: ["produces", "part_of"], direction: OUTGOING, first: 500) { nodes { to { ...ProductContextCard } } pageInfo { hasNextPage } } } }
    } pageInfo { hasNextPage } }
  }
  projectRecords: projects(first: 500) {
    nodes { id title summary revision
      owners: edges(types: ["part_of"], direction: OUTGOING, first: 500) { nodes { to { id __typename } } pageInfo { hasNextPage } }
      products: edges(types: ["produces", "part_of"], direction: OUTGOING, first: 500) { nodes { to { id __typename } } pageInfo { hasNextPage } }
      goals: edges(types: ["pursues"], direction: OUTGOING, first: 500) { nodes { to { id title summary revision } } pageInfo { hasNextPage } }
    }
    pageInfo { hasNextPage }
  }
  reports: weeklyReports(first: 100, after: $after) { nodes { id title revision body } pageInfo { hasNextPage endCursor } }
}
fragment ProductContextCard on Node {
  ... on Product {
    id title summary revision
    revisions: edges(types: ["revision_of"], direction: INCOMING, first: 500) { nodes { from { ... on ProductRevision { id title revision } } } pageInfo { hasNextPage } }
  }
}
`;
