# Project conversations read the previous local-day report

Preparing a project conversation now looks up its own owner's prior local-day project report using the saved report timezone. A present note supplies a transient Wiki document source pinned to its exact revision through the standard thread SDK. Each reply reauthorizes and reloads that snapshot. Missing or unavailable reports leave the conversation usable and add explicit coverage status; intake/product conversations do not attach an arbitrary project note.

The note supplements canonical project context and normal thread history. It has not read the conversation, does not claim coverage of any messages, does not replace the transcript and does not compact late messages. Source content stays out of saved transcript entries.

A local end-to-end fixture creates and revises a report in the built Wiki Worker, resolves its entity into the real public thread service, checks the model prompt on two replies, and verifies both source freshness and preservation of older/late messages. The model is scripted; this establishes no live inference-provider behavior.

The generic source reload limits combined source content to 64 KiB. Oversized notes or access/revision changes after preparation fail the reply visibly rather than silently substitute or truncate source evidence. Missing/unavailable lookup fallback applies before a source is attached.
