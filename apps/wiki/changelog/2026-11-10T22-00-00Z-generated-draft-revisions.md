# Revise generated sections without replacing authored notes

`SaveGeneratedDocument` writes only a generated draft section and its provenance at an exact expected document revision. It retains authored title, summary and body, the published revision and all immutable historical revisions. Identical content/provenance is a no-op; archived, stale or unauthorized writes fail.

The published named mutation supports app-owned report regeneration through normal owner-scoped dispatch. It does not publish documents or bypass publication policy. Tests cover generated regeneration, revision conflicts, member refusals, published-history retention and authored-content preservation.
