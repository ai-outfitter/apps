# Connector architecture across providers

Status: design for app capabilities. Gmail and Calendar now support personal
connections and provisional provider read endpoints; they do not yet implement
the shared mail/calendar contracts or app bindings below. GitHub task reading
is still future work. Slack `chat.read.v1` and PostgreSQL `database.read.v1` are implemented
capabilities in these packages. PostgreSQL is an organization-admin capability for
selected curated views. The existing GitHub App installation and Google
sign-in code have different purposes; neither supplies a Forerunner evidence
connector today.

## The boundary an app sees

An app asks for a **capability** and binds it to an authorized connection and
selected resources. It never receives provider credentials or constructs provider
API URLs. A capability owns its operation and evidence schema. A provider adapter
translates those operations into provider calls. A connection owns authorization,
provider identity, credential state and resource grants. The app installation owns
the binding and its purpose, including which users may use it.

| Consumer need                        | Candidate capability         | Provider and resource                           | Authority owner                                              |
| ------------------------------------ | ---------------------------- | ----------------------------------------------- | ------------------------------------------------------------ |
| Read selected Slack conversations    | `chat.read.v1` (implemented) | Slack workspace and public channel              | Outfitter organization + individual member                   |
| Read work items and their discussion | proposed `work-item.read.v1` | GitHub App installation and selected repository | Outfitter organization; user projection if required          |
| Read selected mail                   | proposed `mail.read.v1`      | Gmail account and mailbox or label              | Individual member, or an explicitly delegated/shared mailbox |
| Read selected events                 | proposed `calendar.read.v1`  | Google account and calendar                     | Individual member, or an explicitly delegated calendar       |

This is a **capability** table, not a promise that all four providers return a
single generic record. A GitHub issue has assignees and state; a mail message has
sender, recipients and thread; a calendar event has start/end, time zone and
attendees. Preserve those typed fields in their own contracts. A small shared
evidence envelope may carry provider, connection/resource identity, stable record
ID, observed time, reference URL and read coverage. It must distinguish event
time from update/observation time and carry `null` when a provider cannot supply
a field. App prioritization belongs above these adapters and cites evidence
records; providers do not assign boulder/stone/sand priority themselves.

`chat.read.v1` currently mixes connection-local channel IDs in its read inputs
with workspace-qualified IDs in returned records. Before another capability
copies it, specify whether a source ID is local to a connection or globally
qualified, and require `listSources()` results and record `sourceId` to agree.
Also specify the unit/format of timestamps. This change needs an explicit
contract migration if it changes existing Slack callers.

## Connection and grant model

For organization app bindings, the authorization key is `(Outfitter organization, connection owner, provider
account/installation)`. It must not be inferred from the member's Outfitter
sign-in provider or email address. An organization enables a connector, a user
or authorized administrator creates a connection, and a separate grant selects
resources and app/user audiences. Each operation rechecks organization purpose,
membership, connection state, provider permission and selected resource.

- **Slack:** personal OAuth user token per organization member. The member
  selects public channels. Another member or an organization admin does not
  inherit that token or grant.
- **GitHub:** the existing `github` row in `connections` binds an
  Outfitter organization to a GitHub App installation. Installation tokens
  express the app's repository permissions, not an individual's repository
  visibility. A personal Forerunner view needs an explicit policy: intersect
  installation access with the member's current GitHub access, or deliberately
  expose an organization-approved shared repository feed. Do not silently treat
  installation access as user consent. Reuse the existing installation binding
  and token broker; avoid a second GitHub App installation flow.
- **Gmail and Calendar:** The initial main-app connectors are personal to the
  signed-in user, keyed by `(user, provider, Google account ID)` with separate
  stored credentials per provider. Disconnect deletes only that local connection;
  it does not revoke Google consent for the OAuth client. They expose provisional
  raw provider reads, not organization/app grants. Google sign-in establishes identity, not Gmail or
  Calendar API consent. Request the relevant API scopes separately, with offline
  access only when background recaps need it. The same Google OAuth grant may
  cover both capabilities, but each capability keeps its own enabled state and
  mailbox/calendar resource grants. Disconnecting one must have an explicit
  effect on the shared credential and the other capability. A delegated or
  shared mailbox/calendar is a distinct authority mode, not an accidental use
  of the connecting person's account.

The manifest describes one capability with a discriminated authentication mode:
Slack uses user-owned OAuth2; PostgreSQL uses organization-owned database
credentials; Bitwarden uses organization-owned resident CLI configuration with
credentials and vault sessions remaining outside the hosted platform. Each
capability validator pins its appropriate mode. Connection
permissions, selected resources, consent and status remain live platform state,
not checked-in metadata. This change introduces no universal connection registry,
shared credential lifecycle or multi-capability OAuth grant. Provider installation
manifests remain separate assets beside Outfitter's manifest.

## Package boundary

Each connector is its own private npm package inside the webapp workspace:
`packages/connector-slack` and `packages/connector-postgres` are implementations. It owns provider
manifests, setup documentation, API adapters, OAuth wire exchanges, transport
fixtures and adapter tests. Its dependency list is explicit and its public
exports define the integration boundary. Source TypeScript exports follow the
existing private `packages/ui` convention and are bundled by the webapp.

`packages/connector-core` contains small provider-neutral manifest/capability
contracts and bounded response reading. It has no dependency on Slack or the
webapp. Connector packages may depend on it but must not import webapp auth,
D1 schema or Astro routes. The platform retains tenant/SSO policy, credential
encryption and persistence, OAuth state, live resource grants and app bindings.
Packaging does not make authorization or deployment independent.

Future capability implementations each get a private package under
this convention. Gmail and Calendar already share a small Google OAuth helper. Shared
credentials still require explicit lifecycle policy in the platform. GitHub's
existing installation broker remains the source of installation authority;
a provider package does not create a parallel installation registry.

## Read execution and daily recaps

A request resolves an app binding to a server-side authorized handle. The handle
loads live grants before each operation, calls the provider through a bounded
transport, and checks authority again before returning evidence. Provider calls
have fixed origins, deadlines, size/page limits, explicit partial/rate-limit/
revoked outcomes, and provider-specific retry rules. A settings/status request
must still allow reconnection or disconnection when a provider read or refresh
fails. Credential rotation must be serialized per connection so a concurrent
grant update cannot discard a newly issued single-use refresh token.

The daily recap scheduler belongs to the app/workflow layer. It enumerates only
enabled organization members and their authorized bindings, pulls bounded
windows, deduplicates by stable provider record ID and update marker, then
persists per-user evidence and recap receipts. A cursor is scoped to connection,
resource and query shape. Partial coverage cannot become an apparently complete
recap; the UI should show the missing source/window. Revocation, grant removal,
member removal and app disablement stop future reads and require the app to
apply its evidence retention/deletion policy. The first implementation need not
build a universal sync engine: bounded on-demand reads suffice until daily
recaps require durable cursors.

Provider-specific synchronization remains inside adapters. Gmail history IDs
can expire and require a full resync; Google Calendar event sync tokens can
expire and require a full resync. Neither token is interchangeable with a page
cursor. Google Calendar incremental sync also restricts query parameters, so
the initial bounded window and later incremental strategy need an explicit
adapter design rather than a shared `since` argument.

## Test and rollout gates

Use one production authorization path in operational app runs and tests. Tests
replace only the provider network boundary with deterministic transports and
synthetic provider accounts; they retain real Outfitter actor sessions, org
membership, connection rows, grants, app bindings and persistence. Each adapter
needs contract tests for identity, pagination, incomplete coverage, rate limits,
revocation, changed grants and credential races. App scenarios add several
enabled/disabled members and verify that one member's evidence never appears in
another's recap. A separate live test with designated accounts and resources is
needed before claiming any provider connection works. A passing fixture test is
not evidence of live consent or data access.

Recommended sequence:

1. Fix the Slack review findings for refresh recovery/concurrency and message
   references, then verify a live personal connection in Unsupervised.
2. Specify source IDs, timestamps and coverage in `chat.read.v1` or a successor,
   and bind Forerunner to authorized Slack evidence with a synthetic multi-user
   daily recap scenario.
3. Choose the next provider based on the actual product need. For GitHub,
   decide personal visibility versus an approved shared repository feed and
   reuse the existing installation. For Gmail, resolve restricted-scope
   verification and data handling before requesting mailbox content. Calendar
   can start with selected event calendars and its own read capability.
4. Extract only the common auth/binding machinery proven by that second
   implementation. Avoid a registry, universal OAuth table or generic record
   model until two providers show the same invariant.

## Provider documentation checked for this design

- [GitHub App installation and user authentication](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app) and [GitHub App permissions](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app).
- [Google OAuth offline access](https://developers.google.com/identity/protocols/oauth2/web-server) and [Gmail scopes and verification](https://developers.google.com/workspace/gmail/api/auth/scopes).
- [Gmail history](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.history/list) and [Google Calendar events and sync tokens](https://developers.google.com/workspace/calendar/api/v3/reference/events/list).

Provider policies and scopes must be checked again when their implementation
starts. This design records the intended boundary, not provider acceptance.
