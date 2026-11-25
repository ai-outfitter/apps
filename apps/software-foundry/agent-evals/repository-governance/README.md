# Repository Governance evaluation

The deterministic fixture invokes the Software Foundry jobs handler and the webapp's Governance and workflow run API handlers with actual Better Auth sessions, an organization membership, a synthetic GitHub authorization, and a migrated temporary SQLite database. It uses the normal platform workflow host, with the app's Astro handlers dispatched in-process. GitHub REST and GraphQL are supplied at the fetch boundary. Git refs, trees, blobs, commits, ancestry, and diffs come from disposable bare Git repositories. The fixture owns the GitHub pull request records.

The existing Foundry box eval runner is designed for issue-to-land workflows. This evaluation uses the webapp's existing route and authentication fixtures and keeps every proposed pull request open.

## Run the product fixture

Use the exact apps and webapp revisions recorded in the run receipt. Run `npm ci --ignore-scripts` in both checkouts. Run these commands from the webapp checkout.

```sh
npm run workflow-schema:check
npm run apps:build -- --metadata

apps_checkout=/absolute/path/to/apps
eval_dir=/absolute/path/to/eval-checkout/apps/software-foundry/agent-evals/repository-governance
bwrap --unshare-user --unshare-pid --ro-bind / / \
  --tmpfs /tmp --dev /dev --tmpfs /dev/shm --proc /proc \
  --clearenv --setenv PATH "$PATH" --setenv HOME /tmp --chdir "$PWD" \
  --setenv FOUNDRY_EVAL_APPS_CHECKOUT "$apps_checkout" \
  node --import tsx "$eval_dir/run.mjs"
```

For each checkout under `/tmp`, add a read-only bind for that checkout after `--tmpfs /tmp` to keep it available in the container. You can also run the Node command directly from a prepared webapp checkout with the same environment. The default fixture intercepts provider fetch calls and rejects destinations outside its synthetic GitHub contract.

Each `POST /api/apps/software-foundry/jobs` runs `community-template-audit` and persists `check.outputs.report`. The fixture compares the report from the normal workflow run GET with the stored slot and the interactive Governance report. It uses the persisted plan for the separate approved proposal. Assertions check the repository revision, provider writes, workflow records, and the pull request's exact base, head and changed paths, including whether each path was added or modified. The cases cover missing templates, maintained custom issue templates, effective inherited coverage, the local issue chooser override, preservation of a partially populated inherited chooser, and replacement of blank canonical templates. Approval without a session, plan, or matching plan ID produces zero provider mutations. Repeating a successful approval returns the same draft with zero additional writes.

An authorized workstation can additionally set `FOUNDRY_GOVERNANCE_FORGEJO_BRIDGE` to an operator-provisioned local adapter exposing `mirrorDraft({ repository, git, body })` and `verifyDraft(receipt)`. The bridge runs at the fixture's actual PR creation call. It mirrors the exact checked Git refs into a disposable Forgejo repository and reads back the native draft and its diff. GitHub audit reads, inheritance, approvals and replays use the GitHub fixture even when this bridge is enabled.

## Run the Spark probe

Use the approved workstation LAN Spark profile documented in the Foundry eval environment example. Run the probe from the apps checkout. [Foundry eval environment example](../.env.example)

```sh
node apps/software-foundry/agent-evals/repository-governance/spark-probe.mjs
```

The probe calls model listing and chat completions with two synthetic scenarios, using no tools and giving the model no Git or product access. It prints sanitized status, latency, and token metrics. The 768-token run used Node v24.22.2 and `GLM-5.3-Flash-EXL3` at apps base `5b00772ac934f67e65451b76eff551b2ef42271f` with runner SHA-256 `96b1fba14d71a064bff601750c0a79bdff1edd340ae529666188d5e5fc212606`. Both completion requests returned HTTP 200. Report-only passed in 10.835 s using 349 completion tokens. The partial local override reached the 768-token ceiling after 26.865 s and failed the output check. The model run did not invoke Repository Governance. See [the sanitized Spark receipt](result.spark-768.json).

A second request set repeated the same prompts at `SPARK_PROBE_MAX_TOKENS=2048`. Report-only passed in 9.412 s with 312 completion tokens. The partial local override finished normally in 46.979 s with 1,335 completion tokens and still failed the expected JSON or path check. See [the retry receipt](result.spark-2048.json).

The 2048-token retry ran at runner SHA-256 `826410a716687669496b6835ab2652d5e73d4523b72c0b8ae61b26f9c0e29a52`.

A third, independently graded probe used a projection of the workflow's actual persisted report from the synthetic partial-override repository. On the approved LAN profile, `SPARK_NO_THINKING=1` turns off model thinking for this probe.

```sh
eval_dir=apps/software-foundry/agent-evals/repository-governance
SPARK_NO_THINKING=1 node "$eval_dir/spark-persisted-probe.mjs" "$eval_dir/persisted-audit-input.json"
```

The Spark returned HTTP 200 in 2.561 s with 235 prompt tokens and 96 completion tokens. All eight assertions passed, including the exact three coverage statuses and source origins, the recorded plan path, and an empty authorized-path list. This provider call summarized a saved synthetic report and had no tools or product authority. The measured script SHA-256 was `3cc2b6e1c47a700aef71acf3dbf168d6e7549cd3167c6dcf0cc3e1531ecad91a`. [Persisted report probe receipt](result.spark-persisted.json)

The checked-in probe selects its endpoint and model from the workstation profile and retains the explicit no-thinking opt-in.

## Initial live Forgejo verification

The workstation ran the full fixture from the clean product revisions below with the bridge against Forgejo 11.0.16. All five jobs persisted read-only reports. The fixture recorded 264 provider requests and exactly nine allowed fixture mutations across 10.920 s of runner wall time. Three HTTP draft PRs were read back open with matching base/head refs and exact additions. The three diffs contained all missing paths, only the PR template when local issue templates were already maintained, and only the feature request template when a custom local bug template suppressed inherited issue templates. The fully inherited repository and the protected inherited chooser produced no PR. Replay created no additional drafts.

The live receipt records both product commits, the fixture digests, and the Forgejo image. The operator-supplied bridge remained in the private handoff and used a disposable container authorization. [Sanitized Forgejo receipts](result.forgejo.json)

## Initial pinned fixture run

The isolated rerun passed on clean apps commit `f939d0dff6fae8f007693182fe057f149d4adbfb` and webapp commit `1b65e882e947dd03377511112bad88954ed665df`. Node v24.22.2 and Git 2.56.0 produced five completed reports in 5.843 s. There were 264 fixture provider requests, including nine approved writes. The runner installed both lockfiles offline and generated the webapp workflow metadata from that checkout. The disposable app installation used the pinned Foundry manifest and workflow YAML. The webapp app-catalog metadata came from the workstation cache because the registry could not be reached from the session. [Pinned fixture receipt](result.fixture.json)

The expanded fixture also advances the disposable default branch between audit and approval. The stale approval returns HTTP 409 with zero provider writes.

## Expanded fixture run

The current runner targets apps `fd16729d84660f17a8a70e50e4465e02e3d9a301` and webapp `cb08841a2bdf4d7993a295b7cb24d2e0bb0583cf` in clean checkouts. Its Bubblewrap run completed six persisted audits in 6.217 s with 329 fixture requests and 12 approved provider mutations. The sixth case approved filling two blank Markdown templates. Git showed only those two modifications. The maintained feature template, malformed YAML, blank YAML, and unrelated file retained their original blob identities. [Expanded fixture receipt](result.fixture-expanded.json)

The first expanded live runner exited at final verification because the Forgejo file API called the two modifications `changed` while the bridge expected `modified`. Independent Forgejo API reads confirmed all four open drafts and their refs and diffs. The same readback independently verified the two blank Markdown repairs and all four preserved blobs. [Expanded Forgejo readback](result.forgejo-expanded-readback.json)

After mapping Forgejo's `changed` status to GitHub fixture status `modified`, the full live rerun passed on the same clean commits and fixture digests. It read back all four open drafts with an exact Git diff of five additions and two blank Markdown modifications. The runner recorded 329 fixture provider requests, 12 approved fixture mutations, and 12.811 s of wall time. [Expanded Forgejo pass receipt](result.forgejo-expanded.json)

## Pinned blank-template replacement run

The six-case offline suite passed on clean apps commit `fd16729d84660f17a8a70e50e4465e02e3d9a301` and webapp commit `cb08841a2bdf4d7993a295b7cb24d2e0bb0583cf`. The run persisted six reports in 6.085 s and recorded 322 fixture requests and 12 approved mutations. Catalog metadata came from the workstation cache and workflow metadata was generated from the webapp pin. [Offline replacement receipt](result.fixture-replacements.json)

The sixth report marked the blank PR and bug templates `incorrect` and listed both canonical paths in `communityTemplates.plan.replacements`. The audit made zero repository writes. The approved draft contained exactly two `modified` entries and preserved the blob IDs of the maintained feature template, malformed noncanonical bug form, and unrelated sentinel. Replaying the same approval returned the same PR number, URL, and head SHA with zero writes. The six-case run used the GitHub fixture. The live Forgejo receipt above covers the five-case baseline.
