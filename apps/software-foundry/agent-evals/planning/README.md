# Software Foundry planning replay

The replay installs the current operational Foundry, Planning, Wiki and Forerunner packages in a disposable app box. It opens a normal OAuth session and calls `graph_documents`, `graph_mutate` and `graph_query` over the platform's public `/mcp`. The organization also has Governance installed. Four disposable Forgejo 11 repositories represent the OS default flake (`box/os`), service charts (`box/charts`), the consuming cluster configuration (`box/ks-config`), and the native clients (`box/native-apple`). The member selected the native repository for the tracking issue.

Run from the apps repository after installing the locked workspace dependencies. Supply a local Software Foundry box image with a matching host checkout and its dependencies, generated catalog, and local app loader. An older box with just the Forgejo patch is sufficient only for the historical Foundry-only replay. Build that image using the repo's [app box instructions](../../../../box/README.md). Point the webapp context at the companion host checkout containing `07f901cdd636f94ef5534445b1d6d9d7d6b88bf0` or its changes.

```sh
apps/software-foundry/agent-evals/planning/run.sh \
  localhost/outfitter/software-foundry-box:planning-eval /tmp/foundry-planning-replay
```

Use a fresh output directory on each run. The runner builds the four operational packages and stages their document metadata before starting the container with network access disabled and no published ports. The platform calls a loopback fixture using the OpenAI Responses API at `/v1/responses`. The fixture returns deterministic structured plans and requires evidence text from every repository in the request. The Forgejo relay forwards real Git and REST requests. For one issue create, it drops the response only after Forgejo returns HTTP 201. The first reconciliation lookup receives a fixture HTTP 502, then the following retry reads the issue directly from Forgejo.

The grading driver checks the persisted planning workflow and its output slot, the anchor's issue and the pinned evidence for its declared scope, and the downloaded artifact's hash and MCP readback. The HTTP read uses the returned installation hostname and path on the box's local HTTP port. It tests a distinct bug with issue publishing disabled and issue-create permission removed, anchor validation, missing read coverage, denied issue publication, reordered source replay, and reconciliation of the lost response. It rejects extra issues, implementation runs, PRs and branch changes in every repository.

The box-only webhook adapter verifies the HMAC on Forgejo's actual issue delivery, looks up the approved installation subscription and invokes the platform's authenticated workflow event phase. Each receipt includes the installed app's decline response and reserved run ID. The host checkout does not contain a native Forgejo ingress, so this replay covers the app phase with a fixture adapter.

The output directory contains `report.json`, retained plans, the inference and Forgejo write receipts, the signed-delivery results and the box's repository bundle. A failing check exits nonzero and records the assertion in `report.json`.

## Keystone request to personal Home

The [Keystone replay receipt](keystone-replay.json) follows the request “Install Forgejo and Grafana from Keystone on iOS and macOS” through the public MCP endpoint. The feature includes standard Grafana dashboard provisioning. The repositories, cluster, users and board activity are disposable fixtures.

1. Foundry reads and cites four separate commits and files the tracking issue in `box/native-apple`. Planning records one project with four repository-owned requirements. The cluster rollout depends on flake defaults and service charts. The native installation flow depends on the cluster rollout. The eval rereads the dependency edges and acceptance criteria through `ProjectDelivery`.
2. The four work items share a Planning project and the Foundry issue. The test marks only the default-flake item done through `UpdateIssue`. The chart, cluster and Apple-client items stay open. Fixture setup moves only the timestamps of the completed item to the previous Chicago calendar day. The separate report and brief are generated through their normal documents.
3. Planning's `GenerateDailyReports` saves the org report. Personal `DailyHome` must find exactly one matching completion and link to its project. Forerunner's `GenerateDailyBrief` consumes the saved report. A second `DailyHome` call must reopen its Wiki revision, identify the completed flake item and cite the org report. The receipt includes the rendered Markdown. A completed issue alone cannot establish device installation or a shipped binary.
4. Governance is installed and discoverable. A passive recorder forwards every call from the org Planning worker and stores only operation and destination names in `planning-host.jsonl`. The result reports calls directed to Governance. No desired count is graded and the request has no Governance instructions. The local provider returns deterministic structured outputs. This tests the installed workflow's behavior; open-ended model tool choice, native client interaction and independent release acceptance remain separate evals.

Build the box using the linked box instructions with the webapp checkout at `07f901cd` or a compatible revision. Use the command above with the resulting local image and a new output folder. No production connectors or model credentials are required.

## Historical Foundry-only replay

The [final replay receipt](final-replay.json) is the raw report from the offline replay with the author-binding fix. The operational app was rebuilt from `61407ce7e5c9f5f2dcb4f11bfa7ed4075923da6b`, which includes the scheduled-job stop guard. The Forgejo host overlay was refreshed through `07f901cdd636f94ef5534445b1d6d9d7d6b88bf0` and applied to local app box image `sha256:fbe0429936cc55edabe404fcd9d85227c007d3baaafe056c79af3af3f2270d2b`. The host patch SHA-256 was `d8a7dd84b52f6b2d8f9d95bd97da6af465eee76abef2465c0d2504605eb9a981`.

The refreshed host returned the verified bot ID in issue preflight. The app declined two properly signed events whose issue author was that bot. The focused planning unit suite also checked that copying the marker to an issue with a different author does not trigger suppression.

The installed-worker regression in `tests/workspace-host.integration.test.ts` exercises the actual finalize route separately. Both the new-issue path and the repair sweep skip the protected planning issue. An unrelated issue still starts the existing implementation workflow.

### Recorded DGX Spark planning run

The [raw answer](spark-keystone/completion.txt) and [tool trace](spark-keystone/trace.json) capture one real GLM-5.3-Flash-EXL3 run. The workstation offered read-only file tools over the same four synthetic repository trees used by the box. Only the model ran on the Spark. Its prompt, tool arguments, file contents, timings and token usage are in the trace. The agent saw the operator request and output schema. The expected work packages and acceptance assertions were outside its read scope. The fixture READMEs do describe responsibilities and some acceptance considerations. This measures planning from those descriptions, not discovery in Keystone's production source code.

To repeat the inference, set SPARK_BASE_URL to the local Spark v1 endpoint and run from this directory with a new output path.

```sh
node spark-agent.mjs /tmp/keystone-agent
python3 normalize-plan.py /tmp/keystone-agent
node check-spark-plan.mjs /tmp/keystone-agent
KEYSTONE_AGENT_PLAN=/tmp/keystone-agent/plan.json ./run.sh localhost/outfitter/keystone-journey:validated /tmp/keystone-product-replay
```

For the exact recorded run, use `spark-keystone/plan.json` as KEYSTONE_AGENT_PLAN. Product replay uses the recorded proposal for the Foundry feature issue and Planning requirements. The issue carries milestone groupings. The Planning route and Home digest use the existing deterministic inference fixture. Planning accepts lowercase requirement keys, so the replay lowercases IDs and references together.

The agent listed four repositories, read six files and generated four requirements and three milestones. The structural checks cover citation provenance, dependency references and cycles, in-scope targets, acceptance criteria and milestone coverage. Its answer used XML despite the JSON instruction. The decoder preserves its content; the raw completion is the review artifact.

The proposal identifies the missing native-to-cluster API in its gaps but assigns no work to deliver it. Its native acceptance test stops at the local catalog. The cluster task pins the flake without declaring the flake task as a dependency. The result is useful for discussing ownership and sequencing, but its acceptance criteria could pass while tapping Install still fails to provision either service.
