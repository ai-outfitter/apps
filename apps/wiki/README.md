# Wiki

The document and page app, published from this repository and installed under
its existing `outfitter/wiki-map` identity. Onto owns the knowledge graph.

Applied migrations 0000–0011 are preserved from the original bundled Wiki.
Migration 0012 imports Document nodes and their recorded revisions without
modifying the archived graph. All archive tables remain available through the
read-only authenticated export route. Generic restores cannot manufacture
revision or approval history.

Graph behavior and its integration/browser suites belong to `apps/onto`.
Wiki tests cover migration/history, revision conflicts, protected publication,
rendering, and the installed document API. The old graph implementation remains
in repository history; it is not included in this app's runtime.

Run `npm run check`, `npm test`, and `npm run test:e2e` in this directory.
Schema/documents: `node --import tsx scripts/document-schema.ts`.
Production activation requires the released package descriptor in webapp and
verified consumer upgrades. Do not delete the bundled source before that gate.
