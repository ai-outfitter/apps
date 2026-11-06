# Issue to triage with resident review

This package forks the smaller `issue-to-review` workflow into an issue-event
workflow. It is general software work: issue provenance, classification, plan, implementation, resident
review, then provider merge observation. The package owns node instructions and
settings; repository `.agents` files are optional context. It does not generate
HTML-specific tasks or change repository protection.

The target execution is GitHub Actions with Outfitter OIDC for triager and
engineer nodes, and the resident through the generic resident transport for independent review.
The issue-started triager and later managed-dispatch engineer have separate
bindings and event policies. The resident keeps its own profile and
identity. The managed model defaults to `gpt-6-luna`; operators may select other
available models meeting their policy. Provider keys come from the platform's
implicit inference configuration, not per-organization secrets.

## Integration status

The combined runtime implements external Actions/OIDC node leases, resident
transport, installation-scoped APIs, pinned profiles and create-only subscription
admission. The app permits new subscriptions only with listed, enabled bindings
whose configuration validates. This is not evidence of resident repository access
or a completed live run. Existing subscriptions cannot be overwritten by this UI.
Binding inputs contain no endpoints, credentials or caller-selected identities.

The existing GitHub App webhook URL `/api/webhooks/github` routes signed issue
deliveries into the same generic ingress as `/api/connector-events/github`.
The event trigger now binds to `github-webhook.inputs.event`, and the trusted
runtime writes `github-webhook.outputs.started` only after an approved GitHub
Actions job authenticates with OIDC. Triage classifies the issue; the separate
plan node runs only when classification says to proceed. Lifecycle deliveries
still invalidate cached installation tokens. GitHub `issues: opened` starts
the triage job for this definition. Later engineer nodes use the separate
managed-dispatch entrypoint. Do not configure a second issue intake path.

Screenshots may be attached to the implementation PR or its CI artifacts. Their
producing run must match the reviewed head, and the resident must actually inspect them.
Dedicated Outfitter artifact storage is optional until configured; its upload
capability fails closed without credentials. Missing check-run access is disclosed:
the resident uses its own Actions jobs/logs and available statuses, while GitHub's
required-check policy remains authoritative. Final live acceptance is pending.

Enable one subscription per repository the organization enabled on its GitHub
connection, in an installation that declares `event.github.issue`. Its
`github-webhook.inputs.settings` includes model, engineerProfile, connectionId and opaque
resource. The provider payload supplies the issue number and immutable repository
ID. The runtime must bind operation scope to the subscription's connection and resource, not trust
settings to select another repository. Only `opened` should create this workflow's
source run. A GitHub `reopened` delivery belongs in the connector inbox but must
not create an Actions start waiting forever. A skipped event is not evidence of
a completed implementation.

GitHub protection is authoritative: required checks and the configured independent
CODEOWNER approval gate auto-merge. The playground uses protected auto-merge;
merge queue is optional per repository. A denied or uncertain protection query
blocks mutation. A review decision or complete workflow status is not proof that
GitHub merged a PR. Final acceptance requires a fresh issue in the Outfitter
playground, actual Actions and the resident execution, artifacts and CI inspection,
provider-confirmed merge, and matching node evidence in the Foundry app.

Fixtures are synthetic engine transition checks only. They do not validate the
transport, provider credentials, screenshots, CI or live merge boundary.

## Playground cutover for the live proof

Keep the existing playground automation active until the GitHub-first path is ready.
Before creating the fresh acceptance issue, replace the legacy
`agent-triage.yml` issue chain with the approved OIDC Actions entrypoint, so the
GitHub issue event starts exactly one engineer job while the signed GitHub App
webhook supplies the workflow source. Preserve `test.yml` and repository
protection. Pin the Actions runner and adapter revisions, verify the approved
bindings and resident access, then enable the source subscription.
Record the playground configuration commit, fresh issue, Actions runs, PR head,
resident review and merge receipt together. Restore the previous triggers if
activation fails before accepting a new run; never leave both chains active.

The nonprod gateway exposes workload callbacks at
`https://inference.ai-outfitter.com/workflow/v1` alongside OIDC inference. It
forwards allowed operations to `WORKFLOW_NODE_URL` on the platform; the provider
package verifies the signed identity before lease admission. Resident control uses
only `https://workspaces.unsupervised.wtf/internal/workflow-residents`, protected
by the platform gateway token. Apply the reviewed nonprod overlay together with
the branch image digest; an image-only rollout does not add these ingress paths
or `WORKFLOW_NODE_URL`. Operator-owned `WORKFLOW_RESIDENT_TARGETS` must be configured
with the resident's scoped target and pinned profile/model before approving its binding.

After publishing the branch Worker and its app-package assets, an authorized
operator can upgrade only the existing Outfitter Foundry installation. Run this
from the same built checkout with `DEMO_DEPLOY_KEY` already in the environment;
never print the key. This does not upgrade other organizations or templates.

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
const index = JSON.parse(await readFile('src/generated/apps/index.json', 'utf8'));
const expectedHash = index['software-foundry'].operational.hash;
const token = process.env.DEMO_DEPLOY_KEY;
if (!token) throw new Error('Missing operator deployment key');
const response = await fetch('https://ai-outfitter.com/api/internal/app-upgrades/outfitter/software-foundry', {
  method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(300000),
  headers: {Authorization: `Bearer ${token}`, 'Content-Type': 'application/json'},
  body: JSON.stringify({expectedHash}),
});
if (!response.ok) throw new Error(`Upgrade failed: ${response.status}`);
const receipt = await response.json();
if (receipt.organization !== 'outfitter' || receipt.template !== 'software-foundry' ||
    receipt.hash !== expectedHash || receipt.mode !== 'operational' ||
    receipt.url !== 'https://software-foundry.outfitter.ai-outfitter.com' ||
    !['unchanged', 'deployed'].includes(receipt.status)) throw new Error('Unexpected upgrade receipt');
console.log(JSON.stringify(receipt));
JS
```
