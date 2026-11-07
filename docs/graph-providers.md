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
Do not retain an authorized host or provider data across requests.

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
Zod. The SDK can forward legacy domain schema exports without importing Onto's
runtime client. Onto's client depends on the SDK. This direction avoids a package
cycle. Contract and client packages participate in independent release-please
components, with workspace dependency updates.

The SDK's `wiki`, `wiki-graph`, `wiki-proposals` and `ontology-measures` schema
exports forward canonical contract objects. Legacy SDK client functions remain
available temporarily while consumers migrate. New product integrations use
`resolveOnto(host, binding)` and `ontoClient(host, provider)`. Stable graph ID salts,
legacy routes and stored identities are preserved.

This is an incremental extraction. Existing SDK graph algorithms still contain
Onto-shaped row/type assumptions and legacy client imports. The package READMEs
list them; the new generic protocol does not require external providers to
implement those algorithms. Platform Wiki-specific discovery also needs consumer
migration before the compatibility layer can be removed.

## Validation

Run the SDK, Onto client and pure contract tests and typechecks from this workspace.
The provider fixtures exercise Onto, minimal-app and connector-shaped identities,
explicit bindings, incompatible versions, revoked access, response bounds and
incomplete results. They establish local contract behavior, not live connector
access or a completed platform rollout.
