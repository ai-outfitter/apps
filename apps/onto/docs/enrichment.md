# Enrich an Onto node or repository

Discover the published mutation with `graph_documents` using
`{scope:"personal",search:"EnrichGraph",schema:true}`. Use an organization
slug instead of `personal` to choose that organization's Onto.

Call `graph_mutate` with `app:"onto"`, `document:"EnrichGraph"`, and the
same explicit scope. The mutation takes optional `node: ID`,
`repositories: [String!]`, and `prompt: String` variables. Pass a node ID
or one to four repository targets. Omitting both retains the recent-thread
enrichment and optional prompt behavior.

These two requests select the same source and anchor when Onto contains a
Repository node with that website. Obtain the actual node ID from an
authorized read of that Onto.

```json
{"scope":"personal","app":"onto","document":"EnrichGraph","variables":{"repositories":["https://github.com/example/monitor"],"prompt":"Identify the software described by the repository."}}
```

```json
{"scope":"personal","app":"onto","document":"EnrichGraph","variables":{"node":"3abe8946-33a2-4801-93c1-f3dd90136c52","prompt":"Identify the software described by the repository."}}
```

Use a canonical HTTPS repository URL or an unambiguous `owner/name`. Every
requested repo needs one active Repository node whose website is that
canonical URL. An existing non-Repository node focuses enrichment on that
node and its scoped context. A missing node, duplicate Repository nodes or
multiple matching repository grants require the editor to resolve the target
before proposals are staged.

Personal access requires an explicit repository grant for **that Onto
installation**, through Connections. The grant's branch and file or directory
define the read boundary. A grant for another app cannot supply this read.
In an organization, an editor uses an active organization-owned connection
that already admits the repository and whose Onto capability allows
`contents.read`. The organization connection must be authorized by its forge.
A personal account or another organization's access cannot supply this read.
Org scans read a bounded set of README and project metadata files at the
default branch's pinned commit. Both paths require a configured default
inference provider owned by the corresponding personal or organization scope.
Private repository calls keep their contents out of workflow inference capture.

The result supplies `runId`, `state` and `batchId`. Explicit targets also
return `targets` with each node's own review receipt. Review the batch on
Changes. Each repository proposal cites the exact path and commit URL.
The workflow submits to the existing member batch policy. Repeating a pending
target returns its existing receipt.

Run the paired installed-package checks from the apps repository root:

```sh
node --import tsx apps/onto/scripts/graph-schema.ts --check
npm run build -w @ai-outfitter/app-onto
node --import tsx --test apps/onto/tests/graph-enrichment.integration.test.ts
```
