# @ai-outfitter/onto

Onto's public domain contracts and client. Import schemas from
`@ai-outfitter/onto/contracts`, and `resolveOnto` / `ontoClient` from
`@ai-outfitter/onto/client`. Discovery selects the explicit `outfitter.onto` v1
contract advertised through `graph.describe`. Supply an installation binding when
more than one compatible provider exists. Queries use the SDK's authorized graph
transport and bounded result protocol; contract compatibility grants no access.

The client also contains legacy Wiki discovery and setup helpers (`defaultWiki`,
`wikiAdapter`, `readWikiGraph`, `selectWikiGraph`, `stableGraphId`, `typeSegment`).
`defaultWiki` uses the historical `wiki-map` entity catalog adapter; use
`resolveOnto` for contract-based discovery. Stable IDs retain the historical
`wiki-link-v1` salt and the unchanged hashing algorithm.

The SDK's Wiki schema exports are deprecated identity-preserving forwards to the
pure contracts package. Its legacy client implementation is temporarily retained
for compatibility: it does not forward through this package, which would create
an SDK → Onto client → SDK cycle. New consumers use this package. Existing SDK
client helpers retain the old discovery behavior. Generic SDK graph algorithms
and server modules still consume compatibility schema exports; this extraction
does not claim to migrate the platform or all graph implementation code.

Document producers use `ontoDocumentsClient(host, provider)` or
`ontoClient(host, provider).documents`, with `provider` selected by `resolveOntoDocuments`. The independently versioned
`outfitter.onto.documents` v1 contract must be advertised; a graph-only Onto
provider remains valid for graph reads and does not implicitly support documents.
The typed methods are `define`, `create`, `live`, `generate`, `revision`, `job`,
`retry`, `seal`, and `policy`. Each validates input and receipts while forwarding
the call through authorized platform actions; a queued or pending dispatch
receipt is not a generated revision. A seal receipt explicitly says
`approval: "not_requested"`. The client never automatically repeats writes.

Document definitions, input/receipt schemas and their operation registry belong
to `@ai-outfitter/onto/contracts`. Source configuration is portable provider-owned
JSON: app adapters specialize that field to validate the particular graph,
GitHub or connector configurations they support. Stored source configurations
use a separate serialized JSON binding; policy/event config names remain short
identifiers. Hosts continue to own authority and dispatch.
