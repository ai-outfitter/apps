# @ai-outfitter/onto

Onto's public domain contracts and client. Import schemas from
`@ai-outfitter/onto/contracts`, and `resolveOnto` / `ontoClient` from
`@ai-outfitter/onto/client`. Discovery selects the explicit `outfitter.onto` v1
contract advertised through `graph.describe`. Supply an installation binding when
more than one compatible provider exists. Queries use the SDK's authorized graph
transport and bounded result protocol; contract compatibility grants no access.

The client is the only home of the Wiki discovery and setup helpers
(`defaultWiki`, `wikiAdapter`, `readWikiGraph`, `selectWikiGraph`, `stableGraphId`,
`typeSegment`); the SDK no longer exports them. `defaultWiki` uses the `wiki-map`
entity catalog adapter and shares one discovery per dispatch with the SDK's
collection helpers; use `resolveOnto` for contract-based discovery. Stable IDs
retain the `wiki-link-v1` salt and the unchanged hashing algorithm.
