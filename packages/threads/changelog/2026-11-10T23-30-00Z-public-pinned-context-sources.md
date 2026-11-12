# Public thread engine loads pinned context sources

The public thread engine now matches the hosted engine's optional authorized source adapter. Each reply resolves its provider's revision-pinned sources again, bounds their combined context and places them in the prompt as attributed untrusted data. Unavailable or oversized sources fail before inference.

Sources are transient: they are not saved as transcript entries or folded into compaction summaries, and they never claim coverage of thread messages. The app-test thread harness accepts the same optional source adapter for real engine integration tests.

Validation includes the generic source/compaction tests and a Planning integration using the built Wiki document entity API and the real thread service.
