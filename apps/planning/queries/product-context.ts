export const productContextQuery = `query ProductContext($root: ID!, $after: String) {
  organization(id: $root) {
    id title slug revision
    developed: edges(types: ["developed_by"], direction: INCOMING) { properties from { ...ProductContextCard } }
    offerings: edges(types: ["offered_by"], direction: INCOMING) {
      from { ... on Offering { products: edges(types: ["packages_product"], direction: OUTGOING) { to { ...ProductContextCard } } } }
    }
    projects: edges(types: ["part_of"], direction: INCOMING) {
      from { ... on Project { products: edges(types: ["produces", "part_of"], direction: OUTGOING) { to { ...ProductContextCard } } } }
    }
  }
  projectRecords: projects(first: 500) {
    nodes { id title summary revision
      owners: edges(types: ["part_of"], direction: OUTGOING) { to { id __typename } }
      products: edges(types: ["produces", "part_of"], direction: OUTGOING) { to { id __typename } }
      goals: edges(types: ["pursues"], direction: OUTGOING) { to { id title summary revision } }
    }
    pageInfo { hasNextPage }
  }
  reports: weeklyReports(first: 100, after: $after) { nodes { id title revision body } pageInfo { hasNextPage endCursor } }
}
fragment ProductContextCard on Node {
  ... on Product {
    id title summary revision
    revisions: edges(types: ["revision_of"], direction: INCOMING) { from { ... on ProductRevision { id title revision } } }
  }
}
`;
