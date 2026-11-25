# Software Foundry local Pi eval

The comparison uses the existing [`subtract-helper` fixture](../apps/software-foundry/agent-evals/evals/subtract-helper) and its `EVAL.ts`. The grader imports the landed default branch, checks that both arithmetic exports work, and runs the fixture's Node tests with a check that they cover subtraction.

| Component | Revision |
| --- | --- |
| Apps source | `eef637da88a2f043b9a21bc70534f6d581d4356c` |
| Webapp source | `41b8a63b3487b19faa5409003cccaebdd48ca9bd` |
| Fixture Git tree | `b8f75c47855d0a3b7031babdaba7fe0bec72040d` |
| Grader SHA-256 | `c9ae5bf8773bc346d37ccf22d04d4429717b90ffd9ef32012865c90e84617ab7` |
| Workspace harness | `@earendil-works/pi-coding-agent@1.0.4` and `@earendil-works/pi-ai@1.0.4` at `7c10bd4337495ee613f2224843ecdf349b80d1df` |
| Spark served weight snapshot | `Mia-AiLab/GLM-5.3-Flash-EXL3-TR3-4bpw@25a44fdbf16862a46b7cc9921142c6c81350af2f` |

The Spark model ID and weight snapshot came from the serving endpoint's model catalog. The box sends Pi's `workspace` provider calls through its local gateway, configured with Spark as the sole upstream.

## Outcomes

| Arm | Observed model | Foundry result | Grader | Wall time | Model calls | Input tokens | Output tokens |
| --- | --- | --- | --- | ---: | ---: | ---: | ---: |
| Spark | `GLM-5.3-Flash-EXL3` | Landed and released inside the box | 2/2 | 2,359.1 s | 61 | 606,809 | 42,647 |
| Native `openai-codex` | — | Awaiting interactive personal consent | — | — | — | — | — |

The Spark gateway recorded 61 HTTP 200 responses from `spark`. Foundry passed both validation steps, obtained final approval on `e98d5b469542fe9c160c4aba219fbd0a30753441`, landed `b87f0c890a494373e1a54a8f224267530b65a545` on the fixture's local default branch and created the box-local `v0.1.0` release. The grader passed both tests on the landed tree. Steps that called the model accounted for 2,296.0 s, or 18.6 output tokens per second. [Sanitized Spark receipt](software-foundry-pi-eval/spark-2026-11-25.json)

The recorded image used a permission-only layer so the unprivileged box user could read the archived runtime sources. The run also made the temporary synthetic input bind mounts readable to the remapped user. Both fixes address startup failures that occurred before model calls. The pinned Pi, fixture and grader were used as-is.

## Reproduce the Spark run

Use clean copies of the source revisions in the table and Node 24. Create and run the checkout with `umask 022` so the box’s runtime user can read the copied sources. Configure `.env.spark` from [the example](../apps/software-foundry/agent-evals/.env.example) for the local Spark endpoint, including `AI_MODEL=GLM-5.3-Flash-EXL3`. Run from the Apps root with free local ports and a container runtime that can reach Spark.

```sh
npm ci
podman build --build-context webapp=/path/to/pinned/webapp \
  --build-arg BOX_APP=software-foundry \
  -f box/Dockerfile -t localhost/outfitter/software-foundry-box:spark-eval .
BOX_CLI=podman BOX_IMAGE=localhost/outfitter/software-foundry-box:spark-eval \
  BOX_PORT=28787 BOX_FORGEJO_PORT=23300 \
  node --import tsx apps/software-foundry/agent-evals/run.ts spark subtract-helper
```

On hosts where rootless Podman remaps the box user, make the runner’s temporary synthetic repository and request readable by that user. Both remain read-only mounts. The recorded Spark run published inspection and Forgejo ports on loopback.

The runner writes the grader outcome and aggregate and per-step metrics under `agent-evals/results/spark/`. Box model time sums the wall time of steps that called the model. Prompt counts include cached input when Pi reports it.

## Personal OAuth custody and consent

Pi 1.0.4's built-in `openai-codex` provider uses its native interactive OAuth login with PKCE and a loopback callback. Pi stores its access and refresh credentials in a mode-0600 `auth.json` under `PI_CODING_AGENT_DIR`, renews them itself, and uses the native Codex Responses transport at the ChatGPT backend. [Pinned Pi provider](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/ai/src/providers/openai-codex.ts), [pinned Pi storage](https://github.com/earendil-works/pi/blob/7c10bd4337495ee613f2224843ecdf349b80d1df/packages/coding-agent/src/core/auth-storage.ts)

OpenAI's documented open-source subscription flow dynamically registers a workspace-bound client and requests `chatgpt.tokens.use.direct` for the public `https://api.openai.com/v1` resource. Pi 1.0.4 exposes that distinct flow under `openai`. Keep each grant with its issuing client and intended resource. [OpenAI sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in), [OpenAI inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)

The gateway speaks Chat Completions. A separate trusted host process uses the pinned Pi transport for native inference. The box runs with networking disabled and reaches host inference over a dedicated Unix socket. The host relay attaches the short-lived broker authorization. Pi owns the personal OAuth grant, refresh and protected storage outside the workspace. The account holder completes interactive consent in a fresh private Pi directory. See the [native eval runner and consent steps](software-foundry-pi-eval/README.md). [OpenAI credential guidance](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)

Five synthetic tests passed. They exercised Pi's native refresh and SSE against fake responses, including a tool call, tool result and final usage. An additional probe sent the real Foundry workspace request through the network-disabled box, gateway, mounted socket and host broker with a synthetic provider. The broker accepted the unchanged Foundry prompt and its 18 tool declarations. That exercise validates the transport and custody boundary.

The candidate for the live native arm is `gpt-6-luna` from the pinned Pi catalog. An authenticated completion will establish whether that personal account can use it. The live arm has no observed model, usage or grade yet.
