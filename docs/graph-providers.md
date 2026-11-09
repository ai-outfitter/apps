# Graph providers and Onto contracts

A graph provider is an authorized installed app exposing the `graph.describe`
read action and the provider-neutral `graph.graphql` protocol. Discovery uses
ordinary `actions.list` and `actions.call`; a descriptor is not authority.
Neither the platform protocol nor provider discovery requires Wiki tables,
Onto's ontology model, or a particular package name.

`@ai-outfitter/app-sdk/graph-provider` discovers declared contracts and capabilities.
Bind an installation explicitly when more than one provider matches. Unknown
contracts/versions, missing bindings and ambiguous matches fail closed. The host
checks ownership, installation access and phase authority on every source call.
Do not retain an authorized host or provider data across requests. Explicit
bindings are filtered locally even if a host returns a broader listing. Before
releasing a completed graph read, the SDK rechecks the current installation/action
permission through the host and discards the response if authority was revoked.
Malformed GraphQL data is unavailable, never complete empty evidence.

`@ai-outfitter/app-sdk/graph-protocol` owns the existing GraphQL wire shapes and
response budgets without importing the ontology implementation. The legacy
`graph-graphql` module reexports these shapes for compatibility. Consumers retain
provider pagination and must distinguish an answered page from a complete report
source. `graphSourceCompleteness` rejects missing connection pagination proof,
remaining pages, errors, truncation and unsupported record arrays. Unknown or
unavailable data is not zero activity.

Cross-deployment references require an explicit trusted deployment identity via
`qualifyGraphReference`; this helper does not connect to another deployment or
supply credentials. Existing local EntityRef values remain valid local addresses.

## Product ownership

| Surface | Canonical owner |
| --- | --- |
| Identity, scoped references, discovery, transport, workflow host | Platform SDK |
| Artifact/evidence citation shapes | Neutral connector core; SDK evidence compatibility export |
| Ontology, validity, graph records, assertions and graph/batch change schemas | `@ai-outfitter/onto-contracts` |
| Public product contracts | `@ai-outfitter/onto/contracts` |
| Product discovery and graph client | `@ai-outfitter/onto/client` |

The pure contracts package depends only on neutral connector-core evidence and
Zod. The SDK's graph algorithms (`graph-query`, `graph-graphql-*`,
`graph-records`) type their rows with those contracts; Onto's client depends on
the SDK. This direction avoids a package cycle. Contract and client packages
participate in independent release-please components, with workspace dependency
updates.

The SDK has no `wiki`, `wiki-graph`, `wiki-proposals` or `ontology-measures`
modules. Schemas are imported from `@ai-outfitter/onto/contracts`; the Wiki client
(`defaultWiki`, `wikiAdapter`, `readWikiGraph`, `selectWikiGraph`, `stableGraphId`,
`typeSegment`) from `@ai-outfitter/onto/client`; `wikiGraphRecords` from
`@ai-outfitter/app-sdk/graph-records`. Contract-based discovery is
`resolveOnto(host, binding)` and `ontoClient(host, provider)`. Stable graph ID
salts, routes and stored identities are unchanged, so deployed data needs no
migration; consumers outside this repository update their import paths when they
take the SDK release that removes the modules.

## Validation

Run the SDK, Onto client and pure contract tests and typechecks from this workspace.
The provider fixtures exercise Onto, minimal-app and connector-shaped identities,
explicit bindings, incompatible versions, revoked access, response bounds and
incomplete results. They establish local contract behavior, not live connector
access or a completed platform rollout.
