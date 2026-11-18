# Bound report previews before atomic Wiki writes

Daily notes now retain bounded repository observation previews with original observed counts, retained/omitted counts, unknowns and exact child Wiki revision references. Personal previews preserve omission totals from already bounded organization reports. Long human sections explicitly direct readers to source reports. Machine data remains ordinary JSON; no compressed or opaque payload is introduced.

Before any mutation, Planning measures the actual JSON variables against the existing 32 KiB transport limit. The existing generated-document mutation creates the document, generated revision and page atomically, avoiding empty shells after failed aggregate writes. Existing empty shells can be recovered through the same revision-guarded generated-only update; authored content and published history remain intact.

A read-only reconstruction of the failing fourteen-project local aggregate round-tripped all child references in fewer than 25 KiB of variables with one mutation and a stable no-op retry. Tests also cover nested preview counts, omitted-source notices, oversized preflight without creation, empty-shell recovery, atomic duplicate rollback and the actual Wiki-to-thread source path.
