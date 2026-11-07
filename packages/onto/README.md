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
