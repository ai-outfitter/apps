# Connector convention

Each connector is a private npm workspace at `packages/connector-<provider>/`,
named `@ai-outfitter/connector-<provider>`. It remains part of the webapp repository
and is consumed through declared package exports, never deep source imports.
The package declares its own dependencies and provides standalone `check` and
`test` scripts. Root CI includes these checks. Each connector implementing a shared capability owns:

- `manifest.json`: Outfitter metadata, validated by the shared manifest schema
  and the implemented capability contract;
- `src/index.ts`: exports the descriptor imported from that manifest and the
  provider adapter;
- `README.md`: setup, permissions, authorization boundaries, fixtures and
  validation instructions;
- provider-specific installation assets, when required. Slack's
  `slack-app-manifest.json` is an asset for Slack's app-management UI, separate
  from Outfitter's connector manifest.

The shared `Connector` interface requires a descriptor. Capability interfaces
extend it with provider-neutral operations: `ChatReadConnector` currently
defines `chat.read.v1`; `DatabaseReadConnector` defines `database.read.v1` for
curated view metadata and bounded rows. Apps consume that capability interface; they do not
select provider endpoints, receive tokens or bypass the authorization service.

`manifest.json` pins the metadata schema version, provider ID, display name,
implementation version, capability contract, supported operations and
authentication ownership. Import and validate it once in the provider module;
status APIs and UI must reuse that descriptor rather than repeating versions.
The manifest is metadata, not an authorization grant or a package release.
Never include credentials, user tokens, selected sources or deployment secrets.

Implemented capability authentication modes are user-owned OAuth2 for Slack,
organization-owned database credentials for PostgreSQL and organization-owned
resident CLI configuration for Bitwarden. Resident CLI configuration contains no
credential: authentication, unlocking and sessions stay in the authorized resident
runtime. Forgejo uses an organization-owned access token. Each capability
constrains its manifest to the appropriate mode. Extend
these contracts only when another implementation needs a different authority model. Declaring an
operation in a manifest does not implement it or authorize its use.

[Slack](../connector-slack/README.md),
[PostgreSQL](../connector-postgres/README.md),
[1Password Connect](../connector-onepassword/README.md),
[Bitwarden](../connector-bitwarden/README.md), and
[Forgejo](../connector-forgejo/README.md) implement this convention.
1Password Connect exposes validation-only vault metadata; it has no secret-read
operation.
Existing recruiting integrations have not yet migrated.

[Cross-provider design](DESIGN.md) explains how this boundary could support
GitHub work items, Gmail and Google Calendar with user-owned grants. Gmail and
Calendar have provider packages sharing Google OAuth transport, but currently
expose provisional personal read endpoints rather than shared app capabilities.
They will gain manifests when their typed capability contracts are implemented.

`@ai-outfitter/connector-core` owns only provider-neutral metadata and capability
contracts plus bounded response reading. Connector packages must not import
webapp source, Astro routes, database schema or authentication services. Provider
HTTP parsing, OAuth exchange/refresh and normalization belong in the connector;
tenant policy, OAuth state, encryption, persistence, grants and authorized app
handles remain in the webapp. Inject transport for deterministic tests.

Expose fixtures through `./testing`, separately from the runtime entry point.
Keep adapter tests in the connector package and route/auth/storage integration
tests in the webapp. Run `npm run connectors:check` and
`npm run connectors:test` from the repository root, or use npm's `--workspace`
option for one package. Package versions and `implementationVersion` currently
match; private packages are not published by this convention.

When adding a provider, give it its own private package, README, dependencies
and tests. Add a manifest when implementing a shared capability. Add only the capability and
authentication contracts that implementation requires. Existing integrations
are not migrated automatically by adopting this convention.

### Workload identities

A runtime may declare `workload: { issuer, verify({ token, audience }) }`. Verification is provider-owned: cryptographic signature, issuer, intended audience, token lifetime, and protocol claim validation happen before returning `{ issuer, subject, claims }`. Return only stable string claims, excluding `jti`, `iat`, `exp`, and `nbf`. The authenticated broker's `workload` request contains provider ID, transient token, and server-selected audience; it carries no credential context. Discovery exposes only the issuer. Generic callers still must compare the verified identity with their pinned dispatch receipt and approval policy and enforce durable replay/lease state. Successful JWT verification alone never grants execution authority.

Invalid workload tokens are denials (403). The broker normalizes verifier 401/404 responses to 403 because those statuses otherwise identify transport failures. Verifier outages remain unavailable; neither failure permits a lease claim.
