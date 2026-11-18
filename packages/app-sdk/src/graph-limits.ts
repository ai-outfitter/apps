// Bounds every graph module shares. No imports: wire contracts and clients read them without the modules that use them.

/** The longest GraphQL document text a request, a selection or a stored KnowledgeGraph carries, in characters. */
export const graphQueryMaxLength = 65_536;
