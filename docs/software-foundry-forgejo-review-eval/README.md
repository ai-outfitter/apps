# Installed Forgejo issue review eval

Run the existing-issue workflow in a fresh Outfitter box with native Forgejo, an installed Foundry Worker and OAuth MCP. The fixture contains one private repository, one pre-existing synthetic issue and two distinct Forgejo users. The harness seeds the issue snapshot directly in the disposable database before OAuth admission. It makes zero issue creation calls.

The runner starts rootless Podman with networking disabled, an immutable local image ID and read-only inputs. The only network traffic in the box is between loopback services. Forgejo receives native Git and REST operations. The relay records paths and status codes, fences issue mutations and landing routes, and can discard successful native publication responses. The independently read Forgejo inventory and Git history grade the effects.

## Run

Use Node 24, Git, GNU SHA-256 tools and rootless Podman. Use a local Foundry box image and an operational package directory with `software-foundry.operational.json`, `schema.graphql`, `documents.json` and `apps-tree.txt`. The box must contain the platform and workspace runtime corresponding to the selected revision. For the installed cases, use a pair that implements `ReviewIssue` or the historical `ReviewForgejoIssue` document, pinned Forgejo workspace checkout and the supported additive repository grant route. Run each case in a fresh output directory under an existing private parent outside Git worktrees.

```sh
BOX_IMAGE=localhost/outfitter/foundry-forgejo-eval:reviewed
PACKAGE=/private/evals/foundry-operational
OUT=/private/evals
for case in refusal happy slash-base before-work before-open before-review before-review-base race-lost provider-fenced; do
  ./run.sh "$BOX_IMAGE" "$case" "$OUT/$case" "$PACKAGE" || exit
done
./run.sh "$BOX_IMAGE" grants "$OUT/grants" "$PACKAGE"
./run.sh "$BOX_IMAGE" grants-revoked "$OUT/grants-revoked" "$PACKAGE"
```

To build a local pre-release pair from committed source with an existing PlanWork box and a populated offline npm cache, use `build-inputs.sh`. It layers the tracked Webapp changes and copies changed workspace modules to the box runtime. The already-installed dependency and generated catalog layers stay pinned to the base box. Use the regular box build if those dependencies change.

```sh
./build-inputs.sh APPS_COMMIT /path/to/webapp WEBAPP_COMMIT \
  localhost/outfitter/foundry-planwork-recovery:platform-90550833 \
  localhost/outfitter/foundry-forgejo-eval:reviewed /private/evals/inputs
```

For the mixed-version check, export the exact legacy gateway module from the Webapp repository and mount it read-only over the isolated host image's gateway entry point. The launcher verifies the module digest before opening the box.

```sh
git -C /path/to/webapp show 82cc31f76b6ca0c1bd91de864229cd777da767aa:workspace/gateway.mjs > "$OUT/legacy-gateway.mjs"
./run.sh "$BOX_IMAGE" mixed-gateway "$OUT/mixed-gateway" "$PACKAGE" "$OUT/legacy-gateway.mjs"
./run.sh "$BOX_IMAGE" draft-read-refusal "$OUT/draft-read-refusal" "$PACKAGE"
```

## Recover a retained issue review

The recovery cases use the installed OAuth MCP mutation `ReviewIssue($input: ReviewIssueInput!)` with explicit `START` and `RECOVER` actions, plus the read-only `IssueReview($runId: ID!)` query. The same `START` document receives both provider values. The fixture exercises native Forgejo and refuses GitHub without an authorized GitHub grant. They preseed the prior terminal host run, failed implementer attempt and retained session reference. The same-lineage app row is first inserted into SQLite at migration 0013 and replayed through migration 0014 before the fixture copies the original fields to the installed application's migrated database. The synthetic target, actor IDs, OAuth session and credentials are created inside the box. Recovery runs one new implementer and reviewer against the original repository, issue snapshot and explicit slash-qualified base ref.

Build the four package files from the selected Apps commit in a clean checkout using Node 24 and the pinned npm lockfile. Run the package build from the root of that checkout. The referenced `PACKAGE` directory must be private and outside the checkout.

```sh
npm ci --offline --no-audit --no-fund
npm exec --offline --workspace @ai-outfitter/app-software-foundry -- \
  outfitter-app-build --mode operational --output "$PACKAGE/software-foundry.operational.json"
cp apps/software-foundry/graph/schema.graphql apps/software-foundry/graph/documents.json "$PACKAGE"
git rev-parse 'HEAD^{tree}' > "$PACKAGE/apps-tree.txt"
```

Apply the reviewed Webapp source and its pinned Apps connector to the prior native eval box. The candidate host and the historical Ocean OCI digest are recorded separately in the evidence.

```sh
HOST=localhost/outfitter/foundry-forgejo-recovery:candidate-dac7bddb
./build-recovery-host.sh /path/to/webapp dac7bddb3ccdb55ef13de849c6c04c73369ff513   "$HOST" "$OUT/recovery-host"
for case in recovery-lost recovery-unknown; do
  ./run.sh "$HOST" "$case" "$OUT/$case" "$PACKAGE" || exit
done
```

| Case | Evidence required |
| --- | --- |
| `recovery-lost` | Wrong scope, unknown ID and read-only member checks pass before recovery. One OAuth caller loses its accepted response while concurrent callers reconcile to one child. Forgejo accepts one branch, one commit, one draft and one exact-head review while the relay discards each response. Repeated progress queries preserve host, app and Forgejo state. The original run, issue and base stay unchanged. |
| `recovery-unknown` | Seed an unreceipted original-lineage branch in native Forgejo. Recovery observes the branch and refuses to start. The original lineage and native state are preserved. |

For the provider-neutral candidate pair, use the archived harness and exact Forgejo launch pins shown in the evidence. Run the GitHub cases with the same operational package and the fixture-specific instructions. [Candidate launch pins](launch-pins-430d-dac7.json) · [GitHub fixture](GITHUB.md)

## Exact release replay

[Launch pins](launch-pins-27b-87ab.json) identify the local image, package, fixtures, and tested harness. Keep the image and all four original package files for byte-identical replay. Source builds made with other caches or retained layers can produce different bytes.

Export both the harness and its PlanWork dependencies from the same tested commit. The evidence snapshot adds the pin file outside that harness.

```sh
git archive 4fb7d288ec76c69785e2240644dcd46412c7609b \
  docs/software-foundry-forgejo-review-eval \
  docs/software-foundry-planwork-eval-284/mcp.mjs \
  docs/software-foundry-planwork-eval-284/pins.json | tar -x -C "$SNAPSHOT"
cd "$SNAPSHOT/docs/software-foundry-forgejo-review-eval"
./run.sh --pins /private/evals/launch-pins-27b-87ab.json \
  63241831f6637fe276fd56994c832b385318211ce8a5cb108c7f2dc1fac69e82 \
  happy "$OUT/happy" "$PACKAGE"
```

The launcher stages copies of the package, harness and dependencies, verifies the selected case, full image ID, source labels, file hashes and fixture base, then mounts the verified copies read-only. The mixed-gateway case additionally stages and verifies the legacy entry point. Use the optional pins flag for all cases when collecting exact release evidence. The result must identify the case requested on the command line.

The release matrix runs `native` with the release pair. The historical native baseline used the earlier PlanWork image and package. [Evidence](EVIDENCE.md)

| Case | Evidence required |
| --- | --- |
| `native` | OAuth discovers the installed PlanWork document. The native fixture driver opens one PR and a second Forgejo user submits one approval at its immutable head. The issue and base stay unchanged. |
| `grants` | The authenticated repository grant route refuses invalid tenant, installation, repo identity, supplied credential and inadequate native access. A held first grant overlaps a second admission and a credential/configuration edit. The original allowlist, both exact grants and the replacement credential survive. Repeating an exact grant leaves the revision unchanged. Newly admitted names stay explicit-only and an enrolled read grant refuses a write upgrade. |
| `grants-revoked` | Demote the disposable caller after Forgejo answers the discovery GET and before the grant consumes it. The caller loses editor standing and no grant persists. |
| `refusal` | OAuth MCP denies the wrong tenant, provider owner, repository ID, issue number or base ref/SHA. Git, issues and PRs stay at the snapshot, with zero workflow runs or model calls. |
| `happy` | One installed run, one local draft PR, one independently attributed formal review and the same receipt on replay. Forgejo and Git agree on repo, base ref/SHA, PR head, single parent, changed paths and exact review commit. Conflicting pins fail. |
| `slash-base` | Review against the literal existing base `release/review-fixture`. Replaying with `main` at the same SHA is refused. |
| `before-work` | Hold a native base read after a workflow row exists, move the base, and release the read. Read one terminal refusal or two scheduler rechecks before inference, branch publication or PR creation. Record whether the scheduler settles the run. |
| `before-open` | Hold the base recheck after Forgejo commits the candidate branch. Move the base. The stale candidate never reaches PR creation. |
| `before-review` | Hold the review model response after it reads the immutable PR commit. Move the candidate branch. The open draft remains and Forgejo receives zero formal review attempts. |
| `before-review-base` | Hold the same review response and move the base. The open draft remains without a formal review. |
| `race-lost` | Hold an OAuth contender in admission while four others submit. Let native branch, commit, draft PR and formal review writes succeed and discard all four responses. Read back one run, one PR, one exact review and no extra publication attempts. |
| `review-not-sent` | Refuse the native reviewer's first publication preflight read. Require the workflow to retry its frozen claim and verify one native review POST on the same head. |
| `authority-retry` | Forward a stale binding revision on the first authenticated reviewer authority callback to the real host. Require a host refusal before any Forgejo review POST, then successful reauthorization and one review on the original head. |
| `draft-read-refusal` | Discard the successful native draft response and return one generic 403 on the subsequent draft-list read. The follow-up app must settle by reading the existing draft and produce one PR and review. |
| `mixed-gateway` | Run the isolated runtime against the exact legacy gateway module. Native Git prefetch succeeds. The configured pinned route returns 401 using the workspace credential and the workflow fails before owner resolution or completion traffic. |
| `provider-fenced` | Configure an organization chain without Spark while the gateway has a local Spark stand-in and a decoy OpenAI endpoint. The authenticated scope resolver omits Spark. The pinned workflow fails with zero calls to either model endpoint and no repository changes. |

The hosted workflow uses Foundry's documented `configure-issue-review` operator phase for setup. The test then submits the workflow through discovered `graph_mutate` with the user's local OAuth grant. The app chooses the workflow and role bindings. The harness observes their persisted IDs and polls with the ordinary scheduler endpoint. The harness observes product state through read-only SQLite connections. The grant revocation fault demotes the synthetic membership during verification.

The workspace provider emulates the Spark Chat Completions protocol and answers only for the synthetic repository. It checks native Git output from each workspace for the detached commit and absence of a remote. Its responses and the actual owner-resolution provider names are logged separately. The runner uses a decoy alternate provider to detect fallback. Real DGX Spark requires a separately authorized disposable route.

The provider relay and Box Kubernetes shim share a container. The checkout probe proves the supplied working tree and the absence of a configured Git remote. Production process isolation and live provider availability require separate evidence.

Keep raw output directories private. `report.json` contains the case result, `forgejo-requests.jsonl` contains the provider request journal, and `repo.bundle` preserves Git objects for independent inspection. The runner records the selected image ID, source tree labels and package file digests. Use these to compare a replay to the evidence pins.
