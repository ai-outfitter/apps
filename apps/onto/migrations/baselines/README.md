# Fresh Onto schema lineage

`v1.sql` is schema only. Standard types and examples belong to the existing JSON
initialization path. Its SHA-256 and immutable legacy coverage live in the app's
`migration-baseline.json`; the builder packages both the original SQL lineage
and the optional baseline. Old migration SQL is never rewritten or removed.

The public SDK executor accepts `migrateAppDatabase(db, migrations, baselines)`.
A baseline applies only when none of its covered names is in the installation
ledger. Its DDL and ledger entries for the baseline and every replaced migration
commit in one transaction. Any existing/partial covered ledger continues the
original migrations and retains authored records and history. Future uncovered
migrations run normally. Retries do not replay a baseline.

Run `node --import tsx apps/onto/scripts/migration-baseline.ts` from the repository
root to verify schema equality against the pinned legacy coverage in a synthetic
in-memory database. `--write` creates a snapshot while preparing a new baseline;
published baselines and their coverage must remain immutable. A later migration
does not extend this baseline. Add a new explicitly reviewed lineage when needed.

The platform must backport the optional `database.baselines` manifest schema and
pass that metadata to the SDK executor before packages using it are released.
Existing two-argument callers retain legacy behavior, but an old strict manifest
parser may reject packages carrying baseline metadata. Package tests are not an
existing-installation activation or a platform deployment.
