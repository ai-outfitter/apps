# Daily Wiki updates

Each organization app gathers its own evidence, summarizes the previous local calendar day and writes its own dated document through its workflow host. Workshop, Software Foundry and Onto expose daily-update schedules with a default time of 02:00. Enable each schedule in its organization installation and choose the same reporting timezone as Planning. Planning publishes its own update when its organization digest runs.

The SDK daily-update helper provides the dated document identity, coverage status, evidence digest, revision guard and producer installation provenance. The organization digest reads the four saved Wiki updates and records their exact revisions. Missing or late documents leave the overview incomplete. Rerun the digest after a late producer finishes.

Workshop observes project revisions, Software Foundry reads its shipped changes, Onto reads updated change batches and Planning uses its project reports.
