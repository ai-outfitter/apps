# Local replay evidence

## Edited-issue restart

Apps `3438cd05` and Webapp `dac7bddb` passed three byte-pinned installed OAuth MCP runs against disposable native Forgejo. The published `ReviewIssue` document hash is unchanged. The fixture used native repository and issue APIs, real Git checkouts and a deterministic model endpoint that inspected the actual implementer prompt. [Exact launch pins](launch-pins-3438-dac7.json) · [Expected and observed results](receipts-3438-dac7.json)

- `RECOVER` refused the edited issue with 409. Five overlapping `RESTART` calls converged on one successor, which used the edited body and the original slash-qualified base. Its single draft remained open and received one independent approval for the exact head. The original run and issue snapshot were preserved.
- Restart refused a native branch read returning 503 and a provider branch with no receipt. Neither refusal added a workflow or provider write. Active and published successors and competing request IDs also refused with zero additional writes.
- A real workspace initialization failure left the first restart with no model or publication activity. After another edit, the next restart preserved both failed runs and published one reviewed draft. The first request replayed its original failed successor.

## Provider-neutral candidate replay

Apps `430d03eb` and Webapp `dac7bddb` passed five installed OAuth MCP cases. All five used the same literal `ReviewIssue` document hash. The three Forgejo runs used a disposable native instance. The two GitHub runs exercised real Git against a local GitHub API and credential fixture that omitted optional GitHub App installation permission metadata and required a scoped pull request lookup. [Exact Forgejo launch pins](launch-pins-430d-dac7.json) · [Expected and observed results](receipts-430d-dac7.json) · [GitHub fixture](GITHUB.md)

The preceding Apps `01bfabbb` and Webapp `89ce827f` pair also passed the same workflow scenarios before the provider compatibility refinements. [Preceding receipts](receipts-01bf-89ce.json)

- Fresh `START` produced one open draft and one formal review on the checkout head for each provider. Both repositories retained their immutable base and open issue.
- Forgejo `RECOVER` preserved the original failed run and its migrated app row. The first caller lost its accepted acknowledgement while four contenders converged on the same child. The relay also discarded the successful native branch, commit, draft and review responses. Native readback found one open draft with one independent approval, and three concurrent progress reads added zero writes.
- Forgejo recovery refused an unreceipted provider branch after reading it from the native instance. Wrong tenant, unknown run and read-only member checks established the authorization boundary.
- GitHub `RECOVER` retained the failed lineage and completed one child on the original slash-qualified ref. The fixture ledger recorded one branch, one commit, one draft and one approval by an independent reviewer. Both recovery cases verified reviewer pull access with push disabled.

## Historical checkout failure and migration fixture

The archived Ocean record used Webapp #1029 at commit `84221cc34526b6e42fac49060b31b0d713a3fe7d` and platform OCI digest `sha256:3cb6635ae7fac2e41b6e25a43df811de81338fecd0cbcac0537e7f0d35000e74`. The installed Software Foundry revision was 2. Its failed run retained one failed implementer attempt with an absent output hash and one session artifact. The underlying runtime reported `Pinned checkout could not initialize.` with zero stages. The app recorded no candidate, review, draft observation or commit proof. A separate native read confirmed the independent reviewer had pull access and push disabled.

The fixture reproduces those persisted facts with a synthetic issue and local identities. The checkout failure is in `workflow_node_attempts.receipt.failure`. The fixture preserves the original app row through migration 0014 and checks the index permits one original target and one recovery child per original. The fixture uses the installed application's candidate schema and package while exercising the migrated prior row through authenticated MCP.

## Coordinated reviewer authority callback

Apps `3fb71a402495b2dd31f9b9c65c9a23e981fdc1ee` and Webapp `9c3c3e6a6c7eda6151501e7e1e3df0b240ac53ce` ran through installed OAuth MCP in fresh network-disabled boxes with native Forgejo. The exact local image `ddd173210ad87a95a39ccfe80944e77d2cc9a07b01415d93d75225245825a0d7` layers the pinned Webapp changes onto the verified final wire image below. Loaded workflow SDK, host, transport, callback route, gateway and reviewer bytes matched their Git blobs. The offline Apps package is byte-identical to the prior wire replay. [Launch pins](launch-pins-3fb7-9c3c.json) · [Sanitized case receipts](receipts-3fb7-9c3c.json)

- Happy and lost-response both passed through the real authenticated callback on the existing `WORKFLOW_NODE_URL` origin. Each callback returned 204 before the first Forgejo review POST. Lost-response discarded four successful native write replies across five overlapping MCP calls and still produced one draft and one approval on its exact head.
- The stale binding revision got 403 from the real host with zero native review POSTs. The app recorded the no-send proof and retried its frozen claim. The unchanged authority request then got 204, followed by one native review POST and one approval on the original draft head.

The observer runs only in the disposable gateway process and records status, request scope and native review POST count. The unmodified requests go straight to the real host on the configured origin. The focused case changes the forwarded binding revision to exercise a stale-authority rejection. The earlier five and 14 exact receipts remain intact.

## Final wire pair replay

Apps `3fb71a402495b2dd31f9b9c65c9a23e981fdc1ee` and Webapp `82d8d85ef37c30399e0f1670e8c0e5ae83df9f92` ran through installed OAuth MCP in fresh network-disabled boxes with native Forgejo. The local image `9e48d229adc68c7d7b5ed8ad38a264f9d6825666d7821ce302fdfb663401c894` layered the exact Webapp Git delta on the verified release-pair image below. The loaded SDK, workflow host and transport, gateway, reviewer and workspace runtime files matched their pinned Git blobs. The operational package was built offline from the exact Apps archive. [Launch pins](launch-pins-3fb7-82d8.json) · [Sanitized case receipts](receipts-3fb7-82d8.json)

- Happy and lost-race each left one open draft and one native approval on its exact head. The lost-race case overlapped five MCP calls and discarded four successful Forgejo replies.
- Candidate-head and base drift before review each stopped the workflow with one open draft and zero formal review attempts.
- The targeted no-effect case refused the first review-list read authenticated by the native reviewer. The app recorded that the write was unsent and retried its frozen claim. The Forgejo journal then showed a successful preflight followed by exactly one review POST. Native readback found one approval on the unchanged draft head. This replay exercises the reviewer proof path through installed MCP. Product unit coverage exercises all four proof paths.

This targeted replay supplements the 14 exact release-pair receipts below. Each case used the pre-existing issue snapshot and the deterministic loopback model fixture. The Forgejo journal recorded zero issue mutations or landing requests.

## Release source pair

All 14 cases passed in fresh network-disabled boxes on Apps `27b628ef42f36f5950ed2a9b44cefe164f10d4b4` and Webapp `87abdb76775a91f1bb35397c4212eac2b7957817`. The exact local image is `63241831f6637fe276fd56994c832b385318211ce8a5cb108c7f2dc1fac69e82`. [Launch pins](launch-pins-27b-87ab.json) · [Sanitized case receipts](receipts-27b-87ab.json)

- The image layered the exact Webapp Git delta onto the verified private e1699 box. The loaded workflow host, gateway, reviewer, runtime and prefetch files matched their Git blobs. The operational package came from the exact Apps Git archive, built in a network namespace with an offline npm cache. Byte-identical replay uses the retained image and package.
- Every case verified the requested case, image ID, source labels, Apps tree, four package file digests, fixture base, and executable harness and PlanWork helper bytes before startup. Launch sources and package bytes were staged privately and mounted read-only. Replacing either the schema or the release image was refused before startup. The receipts identify the tested harness commit and tree, and hash each launch, report and Forgejo journal.
- Five overlapping requests with four discarded publication replies still yielded one native draft and one approval on its exact head. After the generic draft-read 403, a matching fresh replay settled with one PR POST and one review. The first attempt is retained because the harness's SQLite status poll failed after draft recovery.
- The literal slash base passed, and switching to `main` at the same SHA was refused. Drift before work or PR creation prevented the next effect. Both review-drift runs retained an open draft and published zero reviews. Wrong scope and pin requests, grant concurrency, provider exclusion and the mixed gateway also passed.
- The issue snapshot remained intact and the journal showed zero issue writes or landing attempts. All completions stayed with the deterministic loopback stand-in. The mixed-gateway and provider-exclusion cases made zero completion calls.

## Isolated runtime replay

Webapp `e1699c637cf798743c9538d0644f2e9078b8024a` was built from the committed private `82cc31f7` box. Local image `d0844536e268bd17f75f520b41a66b9f40f4d40c34f95f8f7668d5fcdfdcc33a`. The actual loaded gateway, runtime entry point, prefetch worker, and workspace helper modules matched the pinned Git blobs. The box launcher mirrors the runtime's disabled SIGUSR1 inspector option. The tested artifact is the local layered box.

| Installed app package | Result | Evidence |
| --- | --- | --- |
| `b10e2f98` | 13 cases passed, including native baseline and mixed gateway | [Receipts](receipts-e1699-b10e2f98.json) |
| `6e36ea59` | 14 cases passed, including the generic draft-read refusal | [Receipts](receipts-e1699-6e36ea59.json) |

- **Mixed gateway.** The isolated runtime fetched the pinned SHA from native Forgejo using the existing prefetch path. With the exact older gateway entry point mounted, the runtime selected `/pinned-inference`. The older gateway rejected a workspace-authenticated request with 401 because the missing route fell through to gateway-only authentication. The workflow failed before owner resolution or either local completion endpoint. Treat the gateway and workspace runtime as a matched rollout.
- **Generic draft-read refusal.** Forgejo accepted one draft POST. The relay discarded its successful response and returned one generic 403 for the first reconciliation read. The follow-up app kept the error retryable through the host's 120-second finalization quarantine. Native readback found the original draft, followed by one approval of its immutable head and no repeat PR POST.
- **Replay and drift.** The usual four lost publication replies, concurrent admission, literal slash base, scoped provider denial, grant rotation and drift cases passed. Initial harness assertions expecting 404 and deadline-expired concurrent replays are retained beside the corrected receipts. Native issue mutations and landing attempts were zero.
- **Provider and source qualification.** The rootless boxes ran with `--network none` and used a deterministic loopback Spark stand-in. The previous DGX bridge validates a PlanWork-specific request, so it was left disconnected. The product branch moved to newer host and app commits during the replay. These receipts apply to the exact revisions above. Live Ocean execution remains with the operator.

## Exact paired replay

All 11 integrated cases passed on 2026-11-25 using Apps `b10e2f98e9a2ba28d1a6cda14f9b80637f7eb139` and Webapp `82cc31f76b6ca0c1bd91de864229cd777da767aa`. The separate native baseline also passed. The operational package and local box image are identified by digest in the [case receipts](receipts-final.json).

- Five overlapping OAuth MCP submissions converged on one run after the relay discarded successful native responses for branch creation, commit, PR creation and formal review. Forgejo readback showed one open draft, PR #8, by worker ID 2 and one approval by reviewer ID 3 on head `dde39c13f050758e770ac05bdcaef8a448fddc66`. Git readback matched the exact base parent and expected README change.
- Wrong scope and pin inputs produced zero runs. The literal base ref `release/review-fixture` succeeded and the installed mutation refused replay using `main` at the same SHA. Drift before work settled as failed with zero model calls. Drift after candidate commit prevented PR creation. Base and head drift after the reviewer read the candidate preserved the draft and produced zero formal review attempts.
- Overlapping grants preserved both explicit-only entries and the concurrently edited allowlist. The exact replacement credential survived. Repeat admission kept the revision and a read-only grant refused a write upgrade. Dropping editor standing in flight produced 403 with no grant.
- Gateway records identified the deterministic Spark endpoint for both exact bound workspaces. A chain with Spark omitted dispatched no completions to either provider. The alternate endpoint received no calls. The tests used a local provider stand-in and local artifacts. Live Spark and released artifact activation remain separate.

Every run verified the original issue snapshot, zero issue mutations or forbidden provider requests, and no merged PR. The only pulls were native to the disposable repo.

## Native baseline

The 2026-11-25 run used Forgejo 11.0.16, Webapp `905508330e2aeab9bf5e34b2b816e07dce708134` and Foundry package source `22fd6178b9dfefdfc801c3798e702b6f2bab3b7c`. The dependencies and package are the already pinned PlanWork box inputs. [PlanWork pins](../software-foundry-planwork-eval-284/pins.json)

OAuth registered a client, approved PKCE consent, exchanged the code and discovered the installed PlanWork document. The native fixture driver independently cloned and pushed the synthetic candidate, opened the PR and submitted a formal review with a different Forgejo credential. Actual Forgejo readback returned these values.

| Evidence | Value |
| --- | --- |
| Repository and issue | `box/review-fixture`, repo ID 1, pre-existing issue #7 |
| Base | `main` at `097e3f64847a1b428403cd5f628c46cc71a74c40` |
| PR | #8, open, unmerged, author `outfitter` ID 2 |
| Candidate | `91b39a01ffa78ef52f371e7b93b1b24609e2df0f` |
| Review | ID 1, `APPROVED` at the candidate SHA, author `reviewer` ID 3 |
| Issue writes and landing | Zero issue API writes and zero merge requests. The issue snapshot and default branch matched before and after. |

## Repository grant and config concurrency

The 2026-11-25 initial `grants` run passed on Webapp `79404b7b1418b019f2b43af89f67e10e8edce83b`, tree `63786f54c65f0da983c0ebb900fc6c6f9d947b39`, with the prior PlanWork operational package. The exact local box image ID was `6e1f71a156e2705087b5dca674e09e91441c94dc791d59b612a1f7dec5110f74`. The image layered changed tracked platform bytes from that commit on the pinned PlanWork box. The retained layers supply installed dependencies and catalog fixtures.

The relay held the first verification of `box/grant-a` after Forgejo responded and before the app observed it. The second request granted `box/grant-b`. The connection settings then installed a newly minted native token for the same bot and added `box/grant-c` to the allowlist. Releasing the first response produced both distinct numeric grants. The updated ciphertext and the configured allowlist entry survived. A repeated grant left the config and revision byte-for-byte equal. Seven negative requests returned 400, 401, 403 or 404 and preserved the original config. The repository with issue #7 retained its initial Git, issue and PR inventory.

The initial concurrency run preceded the explicit-only grant marker and read-upgrade check. Use eval revision `4cedb8f5` to replay that historical result.

The `grants-revoked` case also passed against this exact admission image. Removing editor standing while the native repository response was held produced 403 and no config or revision change. This case covers loss of authority before the final application check. Atomic authorization across the final database write has its own platform test boundary.

## Installed review candidate

An intermediate app package and Webapp `2674baf8713527bc8de646b048d6ffd7e310ffd3` ran the workflow end to end through OAuth MCP in the box. The app package was built from Apps `d5cc97b540eff436035184ccfbd51cda54d3ac` plus private work-in-progress source delta SHA-256 `c90cf8a548fb5b69bf8a8a4ecc1902aab4fa5e765339ae919d7fc1e6650e3ab7`. The installed package SHA-256 was `7bba937eec19ce4f710404af93b2912bc8f0874ff779c547ca320565b025ad7f`. These are candidate results. The later app commit explicitly pins the selected connection in each workspace approval.

| Case | 2026-11-25 local result |
| --- | --- |
| Refusal | Six scope and pin violations were denied. Zero runs, model calls, branches or PRs. |
| Happy | One completed workflow run, one unmerged draft and exactly one formal approval by reviewer ID 3 on the verified Git head. |
| Slash-bearing base | The draft named `release/review-fixture`. Changing only the base ref to `main` at the same SHA was rejected on replay. |
| Move before work | Forgejo reported the moved base on two scheduler rechecks. Zero inference, branches or PRs. The run was still marked running on this candidate. |
| Move before open | The implementation commit existed before the base moved. The run failed with zero PR create attempts. |
| Move before review | Moving the candidate or base after the reviewer inspected its checkout failed the run. The open draft remained without a submitted review. |
| Race and lost returns | Five overlapping MCP calls resolved to one run. Forgejo accepted one branch, one commit, one draft and one formal review, then the relay discarded all four successful responses. Provider readback still showed one immutable reviewed head. |
| Provider fenced | The real local owner resolver returned a chain containing only the alternate provider. The run failed with no calls to either model endpoint and no repo changes. |

Successful workspace runs resolved their actual organization chain and selected the deterministic Spark endpoint ahead of the alternate endpoint. Native Git output proved that each workspace was detached at its assigned SHA with no configured remote. Forgejo independently attributed PR authorship to `outfitter` ID 2 and the formal approval of that head to `reviewer` ID 3.

The first committed app/platform pair, Apps `9ad4cc2a` and Webapp `2674baf8`, reached OAuth discovery and refused binding setup because that platform did not yet accept the app's explicit workspace connection field. It dispatched no workflow. Installed acceptance on the follow-up pair and real scoped Spark remain separate evidence.

## Explicit connection pin replay

Apps `9ad4cc2a07dcf64369e6f583a5dba68f588b2dbb` and Webapp `3b0fb017a61d488624ed9b2eb2b2974e98b70b92` accepted installed OAuth and configuration with both roles pinned to the disposable Forgejo connection. Refusal remained green. The positive, lost-return and provider-scope runs stopped at dispatch with a repeatable HTTP 409 `Workflow node lease conflict`. Each install persisted one pending workflow, both approved bindings with the expected Forgejo connection ID, and zero node attempts. No work, review or model traffic was dispatched.

The attempt write guard in `workflow-node-execution.ts` applied `provider='github'` to an explicit workspace connection. The persisted connection provider was `forgejo`. The platform lane owns that guard. Apps `ac9fb360` also passed the six OAuth admission refusals with the same Webapp image. The grant-role revocation replay returned 403 and kept config and revision unchanged on that pair.
