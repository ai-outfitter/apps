# Design partner requests

A design partner is a customer that builds the provider's product with it. It is
not a platform concept: the provider's graph records it as a `customer_of` link
from the partner's Organization to the provider's, with `design_partner` set.
Other customers file issues on the provider's public repository.

A partner's agent files a feature or bug request with the provider's Planning
from the partner's own organization. An editor of the provider accepts it, which
files it with Software Foundry's `RequestChanges` (a GitHub issue and Foundry's
workflow), or rejects it with a reason.

## Flow

1. **Flag the partner.** In the provider's graph, the partner's Organization node
   carries `organization_id` (exactly one current node per organization), and its
   current `customer_of` link to the provider has `design_partner: true`.
2. **Refresh.** An editor runs `RefreshDesignPartners` (input `{}`). Planning
   reads its graph and replaces its list of partners (`planning_design_partners`).
   A partner flagged later files once an editor refreshes again.
3. **Submit.** The partner's member runs `SubmitPartnerRequest` with
   `graph_mutate`: `{"scope": "<provider slug>", "fromScope": "<partner slug>",
   "app": "planning", "document": "SubmitPartnerRequest", "variables": {"input":
   {requestId, kind, title, problem, acceptanceCriteria: [{id, text}], bug?, productId?}}}`.
   The brief is the one Foundry's `RequestChanges` takes; `bug`
   (`stepsToReproduce`, `expected`, `actual`, `environment?`) goes with bugs only.
   The platform calls as role `external`, and Planning accepts the call only if
   that organization is in its list. `productId` names a Product node in the
   provider's graph. A replay with the same `requestId` returns the request with
   its current status. That is how the partner reads the outcome, since a partner
   cannot run queries. A replay with different content is refused.
4. **Review.** Editors list requests with `PartnerRequests` (optional `status`).
5. **Accept.** `AcceptPartnerRequest` `{id, revision, target: {repository?, project?}}`
   reads the graph again and is refused if the partner is no longer flagged. Then
   it runs Foundry's published `RequestChanges` as the accepting editor. The
   problem starts with
   `Filed by design partner <name> (organization <id>, user <id>) for <product>.`,
   the product is in the request's `context`, and the request's ID is Foundry's
   `requestId`, so a retry does not file twice. The request becomes `accepted`
   with Foundry's request (`requestId`, `kind`, `issue`, `run`).
6. **Reject.** `RejectPartnerRequest` `{id, revision, reason}`. Nothing is filed.
   The partner reads the reason by replaying its request.

`SubmitPartnerRequest` is the only field open to other organizations. A partner
cannot run Planning's other mutations or `graph.graphql`. Members of the provider
use Foundry's `RequestChanges` directly.

## Not yet

- Linking a request to an issue in the partner's own Planning or graph.
- Planning pages for partner requests (agents use the documents).
- Refreshing the partner list automatically when the graph changes.
