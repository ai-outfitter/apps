# Software Foundry planning replay

The replay installs the current operational Foundry package in a disposable app box. It opens a normal OAuth session and calls `graph_documents`, `graph_mutate` and `graph_query` over the platform's public `/mcp`. It uses two synthetic Git repositories in Forgejo 11, `box/charts` and `box/native-apple`. The latter is the issue anchor.

Run from the apps repository after installing the locked workspace dependencies. Supply a local Software Foundry box image with the matching webapp Forgejo evidence, issue-create preflight and marker reconciliation operations. Build that image using the repo's [app box instructions](../../../../box/README.md).

```sh
apps/software-foundry/agent-evals/planning/run.sh \
  localhost/outfitter/software-foundry-box:planning-eval /tmp/foundry-planning-replay
```

Use a fresh output directory on each run. The runner builds the operational package and stages its document metadata before starting the container with network access disabled and no published ports. The loopback inference fixture returns deterministic structured plans and requires evidence text from both repositories. The Forgejo relay forwards real Git and REST requests. For one issue create, it drops the response only after Forgejo returns HTTP 201. The first reconciliation lookup receives a fixture HTTP 502, then the following retry reads the issue directly from Forgejo.

The grading driver checks the persisted planning workflow and its output slot, the anchor's issue and both pinned evidence sources, and the downloaded artifact's hash and MCP readback. The HTTP read uses the returned installation hostname and path on the box's local HTTP port. It tests a distinct bug with issue publishing disabled and issue-create permission removed, anchor validation, missing read coverage, denied issue publication, reordered source replay, and reconciliation of the lost response. It rejects extra issues, implementation runs, PRs and branch changes in either repository.

The box-only webhook adapter verifies the HMAC on Forgejo's actual issue delivery, looks up the approved installation subscription and invokes the platform's authenticated workflow event phase. Each receipt includes the installed app's decline response and reserved run ID. The host checkout does not contain a native Forgejo ingress, so this replay covers the app phase with a fixture adapter.

The output directory contains `report.json`, retained plans, the inference and Forgejo write receipts, the signed-delivery results and the box's repository bundle. A failing check exits nonzero and records the assertion in `report.json`.
