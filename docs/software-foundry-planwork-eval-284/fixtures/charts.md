# Aster Charts engine synthetic fixture

The fictional engine imports a DashboardSpec with a stable UID, display title,
schema version, list of panels and typed datasource placeholders. A preview runs
schema validation without committing any change. Storage exposes read(uid),
compareAndSwap(uid, revision, spec), and transactional commit. Revisions are
opaque. Repeating the same request should not duplicate a dashboard or activity.
Rejected writes may be reported as stale, invalid or storage unavailable.
Datasource placeholders resolve only against the current local catalog.
