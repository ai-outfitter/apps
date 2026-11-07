# Live read verification

On 2026-11-07 at 15:41 UTC, `captureGithubActivity` read the public
`ai-outfitter/apps` repository using an authenticated, read-only GitHub CLI
transport. The selection was `main`, from `2026-11-01T00:00:00Z` inclusive to
`2026-11-07T00:00:00Z` exclusive.

The capture completed without errors in four API requests. It retained 19 merged
pull requests and 45 commits, with the same branch head before and after:
`28848447e4e1dc2ce36ff60cfed50a92714877dd`.
These are activity counts, not release, deployment or acceptance counts.

Run this from the repository root with dependencies installed and `gh`
authenticated for the source repository. Change the explicit selection for a
different reporting period. The command prints only capture metadata and counts;
it performs no writes.

```sh
node --import tsx --input-type=module - <<'JS'
import { captureGithubActivity } from './packages/connector-github/src/index.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const read = async (path) => {
  const { stdout } = await run('gh', [
    'api', path, '--method', 'GET',
    '-H', 'Accept: application/vnd.github+json',
    '-H', 'X-GitHub-Api-Version: 2022-11-28',
  ], { maxBuffer: 8 * 1024 * 1024 });
  return JSON.parse(stdout);
};
const capture = await captureGithubActivity(read, {
  repository: 'ai-outfitter/apps', branch: 'main',
  start: '2026-11-01T00:00:00Z', end: '2026-11-07T00:00:00Z',
});
console.log(JSON.stringify({
  complete: capture.complete, errors: capture.errors,
  provenance: capture.provenance,
  mergedPullRequests: capture.snapshot.mergedPullRequests.length,
  commits: capture.snapshot.commits.length,
}, null, 2));
if (!capture.complete) process.exitCode = 1;
JS
```

This verifies translation of real GitHub API responses through an injected
transport. It does not verify an installed Outfitter connector, delegated
scheduled access, an Onto report revision or publication. Those acceptance gates
remain separate. Results can change as repository history and source access
change; the recorded observation is not an atomic GitHub snapshot.
