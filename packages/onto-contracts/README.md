# @ai-outfitter/onto-contracts

Pure canonical Onto contracts: ontology definitions and measures, graph write
inputs, assertions, snapshots, change operations, batch proposals and policy
schemas, and shared change-document text. Public product consumers normally use
`@ai-outfitter/onto/contracts`.

This separate package keeps the dependency graph acyclic. It depends only on Zod
and neutral connector-core evidence primitives; it never imports app-sdk, Onto's
client, app routes, persistence, or platform hosts. The SDK depends on this pure
package to type the rows its generic graph algorithms operate on.
The Onto client depends on app-sdk for entity references, authorization-scoped
host calls, generic discovery, and graph transport. Batch runtime authorization,
persistence and review execution remain app-owned.
