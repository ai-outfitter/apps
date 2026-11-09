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

Portable document definitions and operation contracts are exported from
`documents.ts`. The definition outer schema accepts bounded provider-owned JSON
configuration; concrete source adapters must further validate supported source
kinds. Public contracts do not import the SDK graph query schema or platform
hosts. `documentOperations` defines the nine authorized action names, read
intent, input schemas and receipt schemas used by the product client. Retained
captures and seals describe evidence/integrity; policy receipts do not grant
access and seals do not claim approval.
