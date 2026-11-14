# Onto types read by their address names; a staged batch is not unfinished work

Onto's type records now take their entity title from the type's name, the
form addresses use (`Person`, `supplied_by`), instead of the display title
(`People`). Agents searching for a type see the name they write in an
address. The display title still shows on Onto's own pages.

Staging into an open change batch no longer reports the change as pending
caller work. The SDK's `SUBMIT_CHANGES` instruction is now optional and
says the batch is staged and stays open. Before, sidebar agents treated a
successful stage as unfinished, then re-read the batch or staged again.

The sidebar evals in ai-outfitter/webapp (PR #941) measure the effect.
Affected apps must be rebuilt against the updated SDK.
