# Distinguish absent pages from failed reads

The nullable GraphQL page lookup now returns null when the scoped page is absent. Other database or authorization failures still propagate. This allows authorized callers to create a deterministic daily-report page without mistaking a failed lookup for absence. Existing document and page history is unchanged.

Validated by document unit tests covering absent and failing lookups alongside existing revision and publication checks.
