# Local native Pi OAuth arm

Run the [Foundry eval](../software-foundry-pi-eval.md) against the same fixture, grader and box image. The host broker uses the pinned Pi native `openai-codex` provider. The box has a private Unix inference socket and runs with networking disabled. The broker and relay stay on the account holder’s host, outside the disposable box.

## Prepare private Pi

From the Apps checkout, point `WEBAPP` at the pinned webapp checkout, then prepare the example and runtime.

```sh
tools="$PWD/docs/software-foundry-pi-eval"
broker_dir=$(mktemp -d)
pi_runtime=$(mktemp -d)
pi_auth=$(mktemp -d)
pi_login_work=$(mktemp -d)
pi_run=$(mktemp -d)
chmod 700 "$broker_dir" "$pi_runtime" "$pi_auth" "$pi_login_work" "$pi_run"
cp "$tools"/broker/*.mjs "$broker_dir/"
cp "$WEBAPP"/workspace/runtime/package.json "$WEBAPP"/workspace/runtime/package-lock.json "$pi_runtime/"
npm --prefix "$pi_runtime" --userconfig /dev/null ci --omit=dev
model=gpt-6-luna
```

The personal account holder runs Pi in their own terminal, enters `/login`, selects **OpenAI (ChatGPT Plus/Pro)** and **Browser login**, and completes consent in the browser. Return to the terminal after Pi confirms sign-in. Keep the callback in the browser and the credential file in `pi_auth`.

```sh
(
  cd "$pi_login_work"
  umask 077
  env -u OPENAI_API_KEY PI_CODING_AGENT_DIR="$pi_auth" \
    node "$pi_runtime/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" \
    --provider openai-codex --model "$model" --no-tools --no-extensions \
    --no-skills --no-prompt-templates --no-themes --no-session
)
```

## Run once

With the account holder’s approval for `subtract-helper`, start the host broker in a trusted terminal. It prints its loopback URL and the path to a protected file for a short-lived local broker key. Start the relay in a separate terminal with the same directory variables and set `BROKER_PORT` to the printed port. The relay reads the local key file and injects the header on the host. Pi handles the OAuth grant and its renewal.

```sh
node "$broker_dir/local-pi-codex.mjs" \
  --consent subtract-helper --runtime-dir "$pi_runtime" --auth-dir "$pi_auth" \
  --run-dir "$pi_run" --model "$model" --port 0

node "$tools/host-relay.mjs" "$pi_run/inference.sock" "$pi_run/gateway-bearer" "$BROKER_PORT"
```

In the disposable Apps eval checkout, copy the experiment definition and write the sole upstream to an ignored env file. Use a checkout with readable fixture files and `umask 022` so the rootless box user can read the generated synthetic input mounts.

```sh
eval_dir=apps/software-foundry/agent-evals
cp "$tools/native-experiment.ts" "$eval_dir/experiments/openai-codex.ts"
cat > "$eval_dir/.env.openai-codex" <<EOF_ENV
AI_MODEL=$model
INFERENCE_PROVIDERS=[{"name":"openai-codex","baseUrl":"http://127.0.0.1:18181/v1","model":"$model"}]
EOF_ENV
chmod a+r "$tools/box-entry.mjs"
umask 022
env -u OPENAI_API_KEY FOUNDRY_EVAL_NATIVE_MODEL="$model" \
  FOUNDRY_EVAL_TUNNEL_SOCKET="$pi_run/inference.sock" \
  BOX_CLI="$tools/box-cli.mjs" BOX_IMAGE="$BOX_IMAGE" \
  node --import tsx "$eval_dir/run.ts" openai-codex subtract-helper
```

The grant admits one workflow, up to 80 serialized requests over 15 minutes. The relay and broker can be stopped as soon as the runner exits. The stock box labels all non-Spark runs `luna` in its result serializer. The box gateway’s `inference_usage` events give the provider and model that actually answered. Record only provider, model and aggregate status and usage from those events. Inspect the grader result and box metrics in `agent-evals/results/openai-codex/`.

## Synthetic checks

The test suite covers the private directory policy, OAuth refresh and native Codex SSE with fake responses, translation of tool calls and results, usage reporting, the Foundry prompt envelope, and redaction of provider errors.

```sh
PI_BROKER_TEST_RUNTIME="$pi_runtime" node --test "$tools"/broker/*.test.mjs
```
