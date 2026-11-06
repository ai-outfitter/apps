# Actions node adapter (integration draft)

The package adapter claims and completes a pinned workflow node using a fresh
GitHub Actions OIDC token for audience `outfitter-inference`. It supplies only
run/node/attempt IDs; the gateway owns installation scope, binding identity,
workflow SHA expectations, lease validation and output-schema enforcement.

The routes are agreed with the generic executor owner but are not deployed yet.
This package does not start a live Actions job or claim end-to-end execution.

Set trusted operator `OUTFITTER_GATEWAY` to the HTTPS gateway and
`OUTFITTER_NODE_STATE` to a fresh directory under `RUNNER_TEMP`, outside the
repository checkout. The trusted workflow needs `id-token: write`.

1. Run `node actions/cli.mjs claim RUN_ID NODE_ID ATTEMPT_ID` from the pinned
   package checkout. It atomically creates private `attempt.json`, containing the lease and
   credential-free `context`; it refuses to overwrite an existing attempt.
2. The controlled harness must consume the pinned `attempt.json.context` instructions,
   model/profile settings, inputs and output schemas. Use Outfitter OIDC
   inference with a `gpt-6-luna` default or a stronger operator-approved model;
   do not provision organization-specific provider keys. Do not resolve
   repository `.agents` settings as authority. Strip
   `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` from the
   agent process, as the existing Outfitter Actions inference relay does.
3. A trusted artifact step can run `node actions/cli.mjs upload FILE KEY MIME`.
   The adapter hashes the actual bytes, reads Git's actual HEAD, and returns
   opaque artifact metadata plus that HEAD. Do not accept a model-supplied SHA.
   The gateway derives run ownership from the lease. Presigned storage uploads
   never receive the job's OIDC bearer.
4. After a successful harness run, call `node actions/cli.mjs complete OUTPUTS`.
   OUTPUTS is a JSON object keyed by declared output slot names. Never run
   completion under `always()` after failed implementation. A failed client
   exits nonzero and leaves the attempt visible until timeout; there is no
   invented failure, renewal or success callback.

Remaining integration: trusted provider-owned workflow dispatch with a pinned
workflow identity, installation execution bindings, a managed-context harness
adapter (the current upstream Actions catalog wrapper does not provide one),
artifact tool IPC that withholds OIDC credentials from agents, and live OIDC
verification. Only `triage`, `implement`, and provider merge observation are
external engineer nodes; `review` runs as the resident through the resident transport.
Actor output is evidence text, never authority to bypass connector merge policy.

Tests use an injected transport to verify identity/scope checks and credential
separation. They do not prove deployed authorization or an actual agent run.
