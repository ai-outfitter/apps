# Read-only document snapshots for scoped source context

Wiki publishes its existing documents through the canonical entity API as read-only `document` records. Authorized members can read a document's current revision and authored/generated sections; archived documents are absent. Entity discovery declares no create or update operation. Writes remain in the existing document lifecycle.

This supplies the ordinary entity authority and revision check required by generic thread context sources. References grant no access: the platform still checks the source installation's owner and the document provider checks read access. Anonymous and external callers are refused.

Built Worker integration covers member reads, current revision and generated content, denied entity writes and archived/unauthenticated/external behavior. No records are copied into another store.
