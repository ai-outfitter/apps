# Software Foundry PlanWork offline replay for #284

The replay installs the pinned Foundry Worker in a disposable local organization host and uses the standard authenticated OAuth MCP entry point. It runs a deterministic provider on the container loopback with Podman networking disabled. Two synthetic Git repositories supply evidence. A mock publication sink handles the uncertainty case, and repository readback verifies zero issues and PRs.

## Prerequisites and pins

Use a Node 24 host, Git, a POSIX shell, GNU SHA-256 and archive tools, and rootless Podman with working subordinate UID and GID maps for the runner's 1000:1000 container user. Supply the exact local box image and the pinned operational package directory identified by `pins.json`. Copy `apps-tree.txt`, `software-foundry.operational.json`, `schema.graphql`, and `documents.json` together. The launcher checks the immutable image ID, its webapp and Apps box-context tree labels, the package tree, all three file digests, and the installed PlanWork document and step budgets. It runs the inspected image ID.

The box Apps context is Git tree `570526794a2b88476dcaecb15d1e6f3119207ff7`. Its supervisor and runtime remain in the box. The loader installs the separately pinned operational package supplied at launch. An exact replay uses the byte-identified image, including its base layers, dependencies and generated catalog. The dependency layers can travel in a private image archive loaded with Podman; the launcher still verifies the resulting image ID. A cold source build needs npm and OS dependencies, base images, and immutable external catalog package inputs to reproduce those layers. A matching source label alone cannot establish that identity.

Replay uses the verified package bytes. A local rebuild from the pinned Apps commit with Node 24 and its offline npm cache reproduced the schema and documents but produced different operational module chunks. Supply the matching package bundle for exact replay.

## Run

Choose an existing private output parent outside Git worktrees. Each invocation creates a new output directory. Keep these raw results, logs, package files and sandbox bundles outside this evidence directory.

```sh
BOX_IMAGE=localhost/outfitter/foundry-planwork-recovery:platform-90550833
PACKAGE=/private/evals/pinned-package
./run.sh "$BOX_IMAGE" interrupted /private/evals/interrupted "$PACKAGE"
./run.sh "$BOX_IMAGE" legacy /private/evals/legacy "$PACKAGE"
./run.sh "$BOX_IMAGE" uncertainty /private/evals/uncertainty "$PACKAGE"
./run.sh "$BOX_IMAGE" short /private/evals/short "$PACKAGE"
./run.sh "$BOX_IMAGE" cancel /private/evals/cancel "$PACKAGE"
./run.sh "$BOX_IMAGE" delayed /private/evals/delayed "$PACKAGE"
node --test grade.test.mjs
```

Interrupted replay seeds a completed output slot with a running workflow, replays twice concurrently, and checks repaired settlement without changing the slot, dispatching inference or publishing. It also verifies that a divergent completed receipt stays fenced. Legacy replay seeds synthetic failed rows and scoped usage, recovers one eligible request with the same ID, and checks the concurrent claim, denial and collection repair paths. Uncertainty reconciles one mock publication by its original marker. Short uses a disposable 1,500 ms step override. Cancel aborts the authenticated MCP request. Delayed returns a valid fixture answer after 103 seconds. The grader links a successful provider response, the PlanWork receipt and downloaded bytes, and the unique usage row by workflow run and provider attempt before comparing tokens. Timing is a separate check.

[Read-only historical DGX evidence and reproduction notes](EVIDENCE.md).
