# @ai-outfitter/threads

The platform's shared thread service: generic conversation persistence, reply
leases, inference coordination, typed timeline entries and private images. It
generalizes the platform's existing `chats`, `messages` and `attachments`
tables (defined here in `src/schema.ts`, re-exported by `src/db/schema.ts`);
there is no second transcript store.

Apps never import this package. They use `@ai-outfitter/app-sdk/threads`:
`threads.*` workflow-host operations, the browser routes under
`/api/platform/threads`, and provider callbacks they serve at
`/api/internal/threads/v1/<operation>` (`threadProvider()`).

## Adapters

`createThreadService(adapters)` takes everything runtime-specific:

| Adapter | Platform wiring (`src/lib/threads.ts`) |
| --- | --- |
| `db` | the primary drizzle database (D1 on Workers, libSQL on Node), with atomic `batch` |
| `objects` | private attachment object storage (R2/S3) |
| `inference` | the owner's approved provider (`resolveInference`) |
| `accounting` | the usage ledger (`meterInference`, `recordDiagnostic`) |
| `providers` | same-owner `threads.provide` installations and `dispatchAppOperation` callbacks |
| `retain` | `waitUntil` / background work |

## Rules it enforces

- Ownership and visibility on every read: organization threads are private to
  their creator unless created organization-shared; personal threads belong to
  their creator; children copy their parent's owner and visibility; relations
  never grant access. Callers supply a `ThreadPrincipal` built from
  `authenticated()` or a verified workflow-host scope.
- Submissions: `(threadId, submissionId)` plus a payload hash. Exact replays
  return the existing state, conflicting reuse is a 409, `retry` re-runs only a
  failed, aborted, interrupted or partial reply.
- One reply per thread through a lease on `chats` (`leaseToken`,
  `leaseGeneration`); a worker whose lease was taken over cannot write or
  release. Partial output is kept on failure, cancel and disconnect.
- Provider-owned history types are read through the provider, never copied, and
  refuse every mutation.
- Deletion asks a provider that declared `notify: ["deleted"]` first; without its
  acknowledgement nothing is removed. Then entries and images go, children are
  detached and domain records are untouched.

## Tests

`npm test` (alias of `test:integration`) runs `tests/*.test.ts` on in-memory
libSQL with a mock model. `@ai-outfitter/app-test/threads` exposes the same
real service for app package tests.
