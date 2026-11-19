# Visual evidence

Evidence is a captured walkthrough of an exact application version. Planning renders the media; the manifest remains downloadable source. Local/seeded, preview and production captures are identified explicitly. Concept films shown inside Marketing remain demonstration content, not engineering evidence.

## Agent submission

1. Read `EvidenceSchema` and the current project and linked product revision.
2. Capture actual screenshots and recordings. Record the commit, environment, seeded/dirty flags and capture time. Upload media through the producing app's existing authorized artifact routes; preserve hashes.
3. Open an organization graph change batch using the existing Onto workflow.
4. Call `SubmitEvidence` with a stable key, that batch ID and the schema-valid bundle. Retry with the same key, batch and bytes. A changed capture needs a new key. This stages a Document linked to both the canonical project and product revision; it never approves a batch.
5. Submit/review the batch using existing policy. `staged` and `awaiting_review` are not applied. The response contains the app-relative Planning review URL; mount it under the caller's organization.
6. Read `ProjectEvidence` for the index or exact bundle. Browser and MCP share the same projection.

`steps[].media` may contain screenshots, videos or no media. Each media reference includes kind, content type, caption, owner and SHA-256. `steps[].before` pins a prior bundle record revision and step ID; comparisons never silently use a newer record. The schema is generated from `@ai-outfitter/app-sdk/visual-evidence`.

External media requires an explicit load unless it is same-origin or the existing Foundry evidence host. Retrieval still enforces its owner's authorization. Media errors do not erase descriptions. Video uses native controls and loads on demand. No arbitrary manifest URLs are fetched by the reader.

Use Markdown links with descriptive labels in the bundle summary and step descriptions. Link to the exact document revision, conversation or receipt that supports the step. When a reviewer gave feedback, name the reviewing role, describe the requested change, and record the author’s response and the review outcome if known.

## Existing captures

`import-visual-evidence.ts` converts an existing capture manifest plus explicit subject/media/step mapping into a validated bundle. It does not generate media, infer current source state, upload, or apply graph changes. Keep the old source records and versioned media intact. Legacy Demonstration media URLs remain displayable; unknown provenance stays unknown.

## Performance

The evidence page authenticates the canonical project and performs one bounded graph selection for its review neighborhood. It does not read unrelated project context, full type documentation, or fall back to the whole graph. Compact type signatures are sufficient for rendering. Oversized neighborhoods fail explicitly rather than silently dropping evidence.

Index responses paginate the bounded review result. Project card summaries are loaded when visible, with at most three requests in flight; they do not block initial HTML. This is not a materialized global evidence index. The existing graph-provider lookup is deduplicated per request. Video bytes are not prefetched.

Browser tests measure five repeat page navigations, enforce one graph query per evidence page, and verify playable/downloadable media when `EVIDENCE_CAPTURE_IMAGE` and `EVIDENCE_CAPTURE_VIDEO` point at existing captures. These local worker measurements are not production performance claims.

## Testing the evidence page during development

From the repository root, run `npm run test:dev -w apps/planning` to start a local Astro demo server and exercise the release and evidence pages in Chromium. This smoke test reads the synthetic project fixture directly and needs no packaged app. For repeated local checks, keep the server running with `OUTFITTER_APP_MODE=demo npm run dev -w apps/planning -- --host 127.0.0.1 --port 4518`. Playwright reuses that server locally. The operational browser tests use a packaged worker with a simulated organization, Wiki records and authenticated requests.
