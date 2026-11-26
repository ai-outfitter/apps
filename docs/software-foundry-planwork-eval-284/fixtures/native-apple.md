# Aster native UI synthetic fixture

The fictional iOS and macOS apps share an import coordinator. A preview must
include the current revision, proposed title, panel count and unresolved
datasource names. Confirm submits the preview revision. Cancel drops the
preview and leaves storage and activity unchanged. A stale preview must refresh
before another confirm. After an interrupted request, the UI must reconcile
using the request id. Verification is local and uses generated dashboards only.
