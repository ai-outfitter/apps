# Restore legacy local snapshots through canonical contract reconciliation

Local snapshots exported before endpoint contracts existed now pass through the same trusted reconciliation logic used by the Wiki-to-Onto migration before their records enter the current schema. Compatible standard endpoints are reused; otherwise the migration makes the snapshot's existing unconstrained semantics explicit. Already declared contracts remain authoritative and incompatible relationships fail before insertion.

Type IDs, authored definitions, nodes and relationships survive. Each derived contract advances its type revision and records the original definition plus the migration reason and source digest in immutable revision history. Repeated identical loads retain the original migration timestamp and receipt. Source files remain unchanged, and endpoint database triggers remain enabled.

Validated with baseline SQLite trigger tests, synthetic local installation replay and read-only inspection of a workstation snapshot. No private snapshot contents are stored in the repository.
