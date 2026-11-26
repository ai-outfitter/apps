# Forgejo connector

The read adapter implements `repository.read.v1` for one trusted origin.
The workflow operation registry in `src/operations.ts` adds repository evidence,
issue write preflight, marker lookup, issue creation and comments. Each entry
declares its required repository permission and any additional operation grants.
Add the provider handler and its contract tests here. Apps declare the operations
they need. The host enforces those declarations and the connection's grants
before invoking the connector. Preflight also requires the create declaration.

For the read adapter use a scoped access token with `read:user`, `read:repository` and `read:issue`.
Prefer Forgejo's specific-repositories token restriction as an additional layer.
The platform records the actor returned by `/user`; that actor may be a human or
a named resident account. It is the authenticated API actor, not a commit author,
issue author or person the connector may impersonate.

The webapp owns organization authorization, explicit repository grants,
credential encryption and persistence. Operators must set an exact comma-separated
`FORGEJO_ALLOWED_ORIGINS` HTTPS origin allowlist. An empty allowlist denies all.
Private or Tailscale origins work only when the deployed runtime is explicitly
authorized and can reach them; configuration does not prove reachability.
