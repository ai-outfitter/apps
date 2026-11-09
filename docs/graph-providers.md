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
| Graph wire contracts (ontology, validity, graph records, assertions, graph/batch change schemas) and the graph client | Platform SDK: `@ai-outfitter/app-sdk/graph-contracts`, `@ai-outfitter/app-sdk/graph-client` |

Onto is an installed app, not a library. Apps reach it through the platform: the
SDK's graph client (`defaultWiki`, `wikiAdapter`, `readWikiGraph`,
`selectWikiGraph`, `stableGraphId`, `typeSegment`, `resolveOnto`, `ontoClient`)
calls the scoped entity and action host, and Onto's GraphQL documents are served
through `graph.serve`. No app depends on an Onto package. Stable graph ID salts,
routes and stored identities are unchanged.

## Validation

Run the SDK tests and typechecks from this workspace.
The provider fixtures exercise Onto, minimal-app and connector-shaped identities,
explicit bindings, incompatible versions, revoked access, response bounds and
incomplete results. They establish local contract behavior, not live connector
access or a completed platform rollout.
