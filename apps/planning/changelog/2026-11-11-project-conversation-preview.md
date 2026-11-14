# Project conversation design preview

A project with an explicitly saved `project-conversation-preview-<projectId>` document in its owner-scoped Wiki shows a focused Today, Yesterday, and Last week conversation. Proposed goal meters distinguish first-run checkpoints from customer outcomes; all observations remain unknown until provider evidence is connected. Preview replies stay in the current page and do not dispatch work.

Existing project pages remain the fallback when no preview document is present. Project documents, work review, and the existing assistant remain available. Private local preview documents are outside repository fixtures. Numeric targets are proposals, not canonical goal writes or measured results.

Checked the personal homepage link into the Sunny project, three unknown metric cards, draft interaction, and mobile overflow with the local browser. Daily report eval work is tracked independently in the daily-report-evals worktree.

Mobile iteration: replace the three project header buttons with an overflow menu and use a compact assistant icon on small screens. Remove the shared section-card wrapper and render measurements as flat rows/columns. Proposed provider snapshot types and integration notes live in `src/server/measurement-snapshot.ts` and `docs/measurement-snapshots.md`; they do not fetch or persist observations.
