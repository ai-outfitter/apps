# Issue 273 daily brief evidence

The final implementation pin is `08121bc19a3532aa6888ad9dba76626941023c5d`. The earlier app pins below retain the original negative evidence and the subsequent reservation changes.

The first replay uses the same synthetic rows and occurrence times on apps baseline `5b00772ac934f67e65451b76eff551b2ef42271f` and candidate `b6925668dc3b235f6ae868cb418e54b38d97ed5b`. Each source archive resolves its own workspace packages. No Ocean installations were read or modified by this eval.

- At 05:00 Chicago, baseline Forerunner started the brief. Candidate deferred, performed no inference or writes, and returned a 05:05 retry. At 07:00 it read the completed outputs of all four configured discoveries before starting the same reserved brief occurrence.
- The original Onto producer selected nine batch rows based on update time, including four currently committed batches. The candidate selected two ledger commit events by their commit time and independently reported two open and three rejected batch updates. Both earlier commits were excluded.
- The candidate prepared an explicit zero for successful reads of both empty Wiki stores. The authored variant passed exact IDs and revisions from both stores, with generated pages, an unauthorized scope and out-of-window revisions excluded. Failed Wiki collection did not yield zero, and failure of a discovery result slot surfaced even when its outer run was complete.
- Forerunner retained the saved revision on an unchanged retry and on a later-day retry of the original occurrence. The replay rejected a foreign actor before any host call and passed only the owning member's priority to synthesis.
- The Chicago fall-back review included its UTC start and both repeated-hour completions in chronological order, and excluded the end boundary. The unavailable empty case invoked no model and saved nothing. A separately checked empty case provided actual zero evidence.

## Reproduce

From each source archive, after restoring dependencies and adding the same issue 273 harness files:

```sh
suite=apps/forerunner/evals/daily-brief
node --import tsx "$suite/issue-273-run.ts" \
  --dry --revision "$REVISION" --out /tmp/replay-deterministic.json
BRIEF_EVAL_BASE_URL="$SPARK_OPENAI_COMPATIBLE_URL" \
  node --import tsx "$suite/issue-273-run.ts" \
  --no-thinking --revision "$REVISION" --out /tmp/replay-spark.json
node --import tsx --test apps/forerunner/tests/daily-brief-eval.unit.test.ts \
  apps/forerunner/tests/daily-brief.unit.test.ts
node --import tsx "$suite/issue-273-evidence.mjs" --regrade baseline.json candidate.json
```

The run captures the actual app-supplied data before prompting, exact input digest, answer, provider status/IDs/usage when available, rendered Markdown, and every saved revision's provenance. All fixture IDs and content are synthetic. The expected values and concrete actual values are recorded beside each check. In dry mode a minimal transport stub makes write-path behavior observable without grading model quality.

The production app phase, Onto producer query, Wiki GraphQL resolver, Forerunner database queries, and citation validation are executed locally. Discovery run and workflow-write operations, host scope selection and federation paging use a fixture host. The dry results therefore cover app behavior under supplied availability. Host scheduling and the installed Today route are separate from this local app replay.

## Deterministic app replay

The baseline passed 88 of 126 checks. The candidate passed 126 of 126. [Intermediate check results](issue-273-intermediate-evidence.json)

Baseline `5b00772ac934f67e65451b76eff551b2ef42271f`. transport-stub. No model. 0/0 parseable provider responses in 0.0 seconds of client time.
Candidate `b6925668dc3b235f6ae868cb418e54b38d97ed5b`. transport-stub. No model. 0/0 parseable provider responses in 0.0 seconds of client time.

| Case and stage | Baseline | Candidate |
| --- | ---: | ---: |
| `Onto activity` | 1/4 | 4/4 |
| `Onto empty` | 3/4 | 4/4 |
| `nov25-ocean-replay / morning` | 1/6 | 6/6 |
| `nov25-ocean-replay / ready` | 9/13 | 13/13 |
| `nov25-authored-late-discovery / morning` | 0/6 | 6/6 |
| `nov25-authored-late-discovery / ready` | 9/15 | 15/15 |
| `nov25-partial-recovery / partial` | 10/12 | 12/12 |
| `nov25-partial-recovery / recovered` | 9/12 | 12/12 |
| `nov25-partial-recovery / retry` | 6/6 | 6/6 |
| `nov25-partial-recovery / historical` | 6/6 | 6/6 |
| `nov25-empty-confirmed / morning` | 9/12 | 12/12 |
| `nov25-empty-unavailable / morning` | 6/6 | 6/6 |
| `nov25-auth-isolation / foreign` | 1/1 | 1/1 |
| `nov25-auth-isolation / morning` | 9/12 | 12/12 |
| `nov01-chicago-dst / morning` | 9/11 | 11/11 |

### Failed checks

- Baseline, `Onto activity`. producer-collected-commit-events. Expected ["record-1","record-2"]. Observed []. producer-collected-current-proposal-states. Expected ["open","open","rejected","rejected","rejected"]. Observed []. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `Onto empty`. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000010"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-authored-late-discovery / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000011"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false. nothing-from-07:00-leaks-at-05:00. Expected false. Observed true.

- Baseline, `nov25-authored-late-discovery / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 2. Observed null. authored-wiki-evidence-order. Expected ["Reviewed field notes","Documented the handoff"]. Observed []. authored-wiki-revision-links. Expected [["doc-authored",3],["legacy-authored",2]]. Observed []. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-partial-recovery / partial`. requested-half-open-chicago-window. Expected true. Observed false. partial-gaps-carry-failed-leaf-running-disabled-and-unread-sources. Expected [true,true,true,true,true]. Observed [false,false,false,false,false].

- Baseline, `nov25-partial-recovery / recovered`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-empty-confirmed / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-auth-isolation / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov01-chicago-dst / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null.

## Existing test suite

At the pinned implementation SHAs, the two existing daily-brief unit files passed 15/15 on baseline and 13/15 on candidate. Candidate failures were the existing mocks for default schedule creation (the actual call includes `ifUnset: true`) and for scheduled capture (the fixture omits `enabled`, so the handler declines). The issue-specific fixture supplies the relevant schedule fields and exercises the candidate path with real app collection code. Root `npm test` passed all 42 tooling tests with a writable temporary npm cache.

## Live provider

Spark advertised `GLM-5.3-Flash-EXL3` with weights snapshot `25a44fdbf16862a46b7cc9921142c6c81350af2f` and vLLM `0.1.dev20051+g487ecf187`. It returned a short no-thinking generation, response `chatcmpl-887833d391898372` with 13 prompt and 3 completion tokens and finish reason `stop`. The [original five-case baseline experiment](issue-273-baseline-original-spark.json) used provider-default thinking and all five calls hit the 75-second timeout. The issue replay uses the same controlled no-thinking setting and 3,000-token maximum on both revisions. Direct requests use the actual inference prompt and answer schema supplied by the app; production host transport latency and gateway activation are outside this replay.

### Matched 75-second live replay

[Per-case receipts](issue-273-intermediate-evidence.json)

- Baseline returned nine parseable responses from ten calls, including its Onto synthesis. That producer reported four proposals as committed from the batch rows. Three baseline brief responses repeated the four-commit claim. The candidate's producer used the actual ledger and needed no model call.
- Candidate returned five parseable brief responses from eight calls, all saved. Its 07:00 synthesis cited two committed record revisions, two pending updates, three rejected updates and the verified zero Wiki count. Response `chatcmpl-bb26146bf30a320e` took 44.578 seconds with 758 prompt and 452 completion tokens.
- Candidate timed out on authored, partial and recovered synthesis, without a Wiki write on those attempts. The recovery retry then wrote revision 1 because no earlier attempt had saved. The next-day replay retained that revision.
- Checked-empty synthesis cited zero Wiki revisions and zero Onto activity. The unavailable case had no prompt, no provider call and no saved brief. That difference was enforced before synthesis.

Baseline `5b00772ac934f67e65451b76eff551b2ef42271f`. live-spark. GLM-5.3-Flash-EXL3. 9/10 parseable provider responses in 496.0 seconds of client time.
Candidate `b6925668dc3b235f6ae868cb418e54b38d97ed5b`. live-spark. GLM-5.3-Flash-EXL3. 5/8 parseable provider responses in 409.8 seconds of client time.

| Case and stage | Baseline | Candidate |
| --- | ---: | ---: |
| `Onto activity` | 1/4 | 4/4 |
| `Onto empty` | 3/4 | 4/4 |
| `nov25-ocean-replay / morning` | 1/6 | 6/6 |
| `nov25-ocean-replay / ready` | 7/13 | 18/18 |
| `nov25-authored-late-discovery / morning` | 0/6 | 6/6 |
| `nov25-authored-late-discovery / ready` | 13/20 | 12/14 |
| `nov25-partial-recovery / partial` | 16/18 | 10/12 |
| `nov25-partial-recovery / recovered` | 13/17 | 10/12 |
| `nov25-partial-recovery / retry` | 6/6 | 3/6 |
| `nov25-partial-recovery / historical` | 6/6 | 6/6 |
| `nov25-empty-confirmed / morning` | 14/18 | 18/18 |
| `nov25-empty-unavailable / morning` | 6/6 | 6/6 |
| `nov25-auth-isolation / foreign` | 1/1 | 1/1 |
| `nov25-auth-isolation / morning` | 13/17 | 17/17 |
| `nov01-chicago-dst / morning` | 14/16 | 16/16 |

### Failed checks

- Baseline, `Onto activity`. producer-collected-commit-events. Expected ["record-1","record-2"]. Observed []. producer-collected-current-proposal-states. Expected ["open","open","rejected","rejected","rejected"]. Observed []. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `Onto empty`. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000010"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / ready`. wiki-write-count. Expected 1. Observed 0. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. live-answer-saves-with-resolvable-citations. Expected true. Observed false.

- Baseline, `nov25-authored-late-discovery / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000011"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false. nothing-from-07:00-leaks-at-05:00. Expected false. Observed true.

- Baseline, `nov25-authored-late-discovery / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 2. Observed null. authored-wiki-evidence-order. Expected ["Reviewed field notes","Documented the handoff"]. Observed []. authored-wiki-revision-links. Expected [["doc-authored",3],["legacy-authored",2]]. Observed []. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Candidate, `nov25-authored-late-discovery / ready`. wiki-write-count. Expected 1. Observed 0. live-answer-saves-with-resolvable-citations. Expected true. Observed false.

- Baseline, `nov25-partial-recovery / partial`. requested-half-open-chicago-window. Expected true. Observed false. partial-gaps-carry-failed-leaf-running-disabled-and-unread-sources. Expected [true,true,true,true,true]. Observed [false,false,false,false,false].

- Candidate, `nov25-partial-recovery / partial`. wiki-write-count. Expected 1. Observed 0. live-answer-saves-with-resolvable-citations. Expected true. Observed false.

- Baseline, `nov25-partial-recovery / recovered`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Candidate, `nov25-partial-recovery / recovered`. wiki-write-count. Expected 1. Observed 0. live-answer-saves-with-resolvable-citations. Expected true. Observed false.

- Candidate, `nov25-partial-recovery / retry`. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. existing-revision-retained. Expected ["unchanged",1]. Observed ["saved",0].

- Baseline, `nov25-empty-confirmed / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. model-cites-checked-zero-wiki-activity. Expected true. Observed false.

- Baseline, `nov25-auth-isolation / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Baseline, `nov01-chicago-dst / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null.

### Matched 150-second authored retry

Re-ran `--case nov25-authored-late-discovery --timeout-ms 150000 --no-thinking` with the same revisions, cases and Spark model. [Authored retry transcript and receipts](issue-273-intermediate-evidence.json)

The candidate returned valid JSON and saved the brief with resolvable source refs. It used 2025 in the opening, assigned both Wiki revisions to the member without author evidence, and called two committed batch names pending. The prompt supplied 2026, authorized scopes and ledger revisions, with the batch names attached only to commits. The semantic checks score these as failures independently of schema acceptance.

Baseline `5b00772ac934f67e65451b76eff551b2ef42271f`. live-spark. GLM-5.3-Flash-EXL3. 3/3 parseable provider responses in 79.1 seconds of client time.
Candidate `b6925668dc3b235f6ae868cb418e54b38d97ed5b`. live-spark. GLM-5.3-Flash-EXL3. 1/1 parseable provider responses in 38.1 seconds of client time.

| Case and stage | Baseline | Candidate |
| --- | ---: | ---: |
| `Onto activity` | 1/4 | 4/4 |
| `Onto empty` | 3/4 | 4/4 |
| `nov25-authored-late-discovery / morning` | 0/6 | 6/6 |
| `nov25-authored-late-discovery / ready` | 13/20 | 17/20 |

### Failed checks

- Baseline, `Onto activity`. producer-collected-commit-events. Expected ["record-1","record-2"]. Observed []. producer-collected-current-proposal-states. Expected ["open","open","rejected","rejected","rejected"]. Observed []. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `Onto empty`. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `nov25-authored-late-discovery / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000011"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false. nothing-from-07:00-leaks-at-05:00. Expected false. Observed true.

- Baseline, `nov25-authored-late-discovery / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 2. Observed null. authored-wiki-evidence-order. Expected ["Reviewed field notes","Documented the handoff"]. Observed []. authored-wiki-revision-links. Expected [["doc-authored",3],["legacy-authored",2]]. Observed []. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Candidate, `nov25-authored-late-discovery / ready`. model-uses-reporting-year. Expected []. Observed ["2025"]. model-does-not-invent-wiki-author. Expected []. Observed ["You authored two Wiki revisions yesterday: reviewed field notes in your Personal Wiki (document revision 3) and documented the handoff in the fixture-team Wiki (legacy graph revision 2)."]. model-does-not-assign-commit-batch-names-to-pending-or-rejected. Expected []. Observed ["Check the 2 pending Onto batch updates (including Synthetic proposal A and B) to see whether any should be committed or rejected."].

## Integrated app candidate with reserved-run replay

The app candidate `db95f0385e23129381c7649f5fa349346bcfb10c` adds default provisioning, discovery receipts and terminal run replay. The same raw cases now drive the explicit clock-phase envelope on both revisions. The host fixture retains completed slots so the replay can distinguish a deferred original occurrence, a separate recovery run for the same day, and a repeated dispatch of a settled reservation. The checks compare actual discovery IDs and result order in the prompt and verify that the settled reservation does not start or synthesize again.

The matched dry run passed 86/135 baseline checks and 135/135 candidate checks. The three existing app unit files passed all 23 tests at the integrated candidate pin. [Baseline report](issue-273-baseline-reservation-deterministic.json) · [Intermediate check results](issue-273-intermediate-evidence.json)

Baseline `5b00772ac934f67e65451b76eff551b2ef42271f`. transport-stub. No model. 0/0 parseable provider responses in 0.0 seconds of client time.
Candidate `db95f0385e23129381c7649f5fa349346bcfb10c`. transport-stub. No model. 0/0 parseable provider responses in 0.0 seconds of client time.

| Case and stage | Baseline | Candidate |
| --- | ---: | ---: |
| `Onto activity` | 1/4 | 4/4 |
| `Onto empty` | 3/4 | 4/4 |
| `nov25-ocean-replay / morning` | 1/6 | 6/6 |
| `nov25-ocean-replay / ready` | 9/15 | 15/15 |
| `nov25-authored-late-discovery / morning` | 0/6 | 6/6 |
| `nov25-authored-late-discovery / ready` | 9/17 | 17/17 |
| `nov25-partial-recovery / partial` | 10/14 | 14/14 |
| `nov25-partial-recovery / recovered` | 9/14 | 14/14 |
| `nov25-partial-recovery / retry` | 4/7 | 7/7 |
| `nov25-partial-recovery / historical` | 6/6 | 6/6 |
| `nov25-empty-confirmed / morning` | 9/12 | 12/12 |
| `nov25-empty-unavailable / morning` | 6/6 | 6/6 |
| `nov25-auth-isolation / foreign` | 1/1 | 1/1 |
| `nov25-auth-isolation / morning` | 9/12 | 12/12 |
| `nov01-chicago-dst / morning` | 9/11 | 11/11 |

### Failed checks

- Baseline, `Onto activity`. producer-collected-commit-events. Expected ["record-1","record-2"]. Observed []. producer-collected-current-proposal-states. Expected ["open","open","rejected","rejected","rejected"]. Observed []. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `Onto empty`. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000010"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: calendar-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: planning-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: follow-up-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run","/apps/forerunner/runs/calendar-discovery-run","/apps/forerunner/runs/planning-discovery-run","/apps/forerunner/runs/follow-up-discovery-run"]. Observed []. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-authored-late-discovery / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000020"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false. nothing-from-07:00-leaks-at-05:00. Expected false. Observed true.

- Baseline, `nov25-authored-late-discovery / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: calendar-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: planning-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: follow-up-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run","/apps/forerunner/runs/calendar-discovery-run","/apps/forerunner/runs/planning-discovery-run","/apps/forerunner/runs/follow-up-discovery-run"]. Observed []. wiki-coverage-count-in-prompt. Expected 2. Observed null. authored-wiki-evidence-order. Expected ["Reviewed field notes","Documented the handoff"]. Observed []. authored-wiki-revision-links. Expected [["doc-authored",3],["legacy-authored",2]]. Observed []. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-partial-recovery / partial`. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run"]. Observed []. partial-gaps-carry-failed-leaf-running-disabled-and-unread-sources. Expected [true,true,true,true,true]. Observed [false,false,false,false,false].

- Baseline, `nov25-partial-recovery / recovered`. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: calendar-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: planning-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: follow-up-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run","/apps/forerunner/runs/calendar-discovery-run","/apps/forerunner/runs/planning-discovery-run","/apps/forerunner/runs/follow-up-discovery-run"]. Observed []. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-partial-recovery / retry`. occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000031"]. existing-revision-retained. Expected ["saved",1]. Observed ["unchanged",1]. terminal-reservation-read-without-a-second-collection. Expected [true,0]. Observed [false,1].

- Baseline, `nov25-empty-confirmed / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov25-auth-isolation / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov01-chicago-dst / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null.

## Related deterministic verification

The installed Forerunner test commit `17fb1c6197d9d7123dacba4470c845b8480fbf9e` uses the shared fixture at runtime candidate `db95f0385e23129381c7649f5fa349346bcfb10c`. Its worker reported 80/80 unit checks, 6/6 integration checks and 5/5 Chromium checks. The installed Today test verified date, scope and source filters with no matching activity and retained the existing saved brief revision. A Workerd test posted the clock payload through the packaged schedule endpoint.

```sh
node --import tsx --test apps/forerunner/tests/morning-brief.integration.test.ts
cd apps/forerunner
npm run test:e2e -- morning-brief.browser.spec.ts day-review.browser.spec.ts navigation.browser.spec.ts
```

The webapp worker ran the actual scheduler tick, scoped workflow RPC and migrations with synthetic app dispatch. It reproduced the 05:00 before 07:00 dispatch on the exact platform baseline `3cce0ca9459c565299ba8904613e4e454282e7ab`, then reported 22/22 local scheduler and boundary checks at `374e1b2d31f60f24bf31d9da731b0b2d332cbb53`. These verified stable original occurrence timing under overlapping ticks, readiness and cutoff, failed leaf output, and lease recovery. A separate local signed-in Today browser run passed the fresh-account empty-thread regression and all eight Daily Home checks.

```sh
node --import tsx --test tests/installation-schedule-morning.test.ts tests/workflow-schedules.test.ts tests/schedule-source.test.ts tests/app-package-boundary.test.ts
npm run test:e2e -- tests/e2e/today-empty.spec.ts
npm run test:e2e:ui -- daily-home.spec.ts
```

## Earlier candidate recovery retry

The 150-second retry of the Ocean and partial-recovery cases at `b6925668dc3b235f6ae868cb418e54b38d97ed5b` returned all three model answers. Spark saved the partial brief at cutoff and saved an updated brief after recovery. The 75-second attempt's missing writes were provider timeouts. The Ocean retry repeated the unsupported pending batch-name attribution; it remained a model failure even with valid citations.

- Partial cutoff response `chatcmpl-b68a066e27e55159`, 21.792 seconds, 728 prompt and 266 completion tokens.
- Recovered response `chatcmpl-b983958d0b746356`, 32.336 seconds, 758 prompt and 469 completion tokens.

[Recovery retry transcripts and receipts](issue-273-intermediate-evidence.json)

## Final app implementation

Pin `08121bc19a3532aa6888ad9dba76626941023c5d` adds explicit attribution instructions, labels Onto's named proposal batches as commit-bearing, and renders the saved previous-day evidence in its own cited section. The same reserved-run fixture passed all 135 deterministic checks again. [Pinned candidate deterministic report](issue-273-pinned-candidate-deterministic.json)

The final Spark replay uses the reserved-run fixture, the same model snapshot and `--no-thinking --timeout-ms 150000` on both revisions. The intermediate reservation candidate also returned 7/7 live responses with two semantic failures. It attributed Wiki revisions to the member and assigned two commit batch names to pending proposals. [Intermediate Spark receipts](issue-273-intermediate-evidence.json)

[Matched baseline Spark report](issue-273-baseline-reservation-spark.json) · [Pinned candidate Spark report](issue-273-pinned-candidate-spark.json)

The baseline received 10/10 responses and the candidate received 7/7. The candidate passed six of seven synthesized case stages. Its authored-Wiki response `chatcmpl-b9434a258c1e8fb4` took 60.169 seconds with 1,075 prompt and 720 completion tokens. It again said the member authored both revisions. The cited evidence establishes revision visibility and scope. It supplies no author identity. The deterministic activity section preserved both source IDs and the correct Onto distinctions, and the model used the right reporting year and did not put the commit batch names in the pending group on this attempt. The authored case remains a synthesis failure.

Baseline `5b00772ac934f67e65451b76eff551b2ef42271f`. live-spark. GLM-5.3-Flash-EXL3. 10/10 parseable provider responses in 312.7 seconds of client time.
Candidate `08121bc19a3532aa6888ad9dba76626941023c5d`. live-spark. GLM-5.3-Flash-EXL3. 7/7 parseable provider responses in 235.3 seconds of client time.

| Case and stage | Baseline | Candidate |
| --- | ---: | ---: |
| `Onto activity` | 1/4 | 4/4 |
| `Onto empty` | 3/4 | 4/4 |
| `nov25-ocean-replay / morning` | 1/6 | 6/6 |
| `nov25-ocean-replay / ready` | 13/20 | 20/20 |
| `nov25-authored-late-discovery / morning` | 0/6 | 6/6 |
| `nov25-authored-late-discovery / ready` | 13/22 | 21/22 |
| `nov25-partial-recovery / partial` | 16/20 | 20/20 |
| `nov25-partial-recovery / recovered` | 13/19 | 19/19 |
| `nov25-partial-recovery / retry` | 4/7 | 7/7 |
| `nov25-partial-recovery / historical` | 6/6 | 6/6 |
| `nov25-empty-confirmed / morning` | 14/18 | 18/18 |
| `nov25-empty-unavailable / morning` | 6/6 | 6/6 |
| `nov25-auth-isolation / foreign` | 1/1 | 1/1 |
| `nov25-auth-isolation / morning` | 14/17 | 17/17 |
| `nov01-chicago-dst / morning` | 14/16 | 16/16 |

### Failed checks

- Baseline, `Onto activity`. producer-collected-commit-events. Expected ["record-1","record-2"]. Observed []. producer-collected-current-proposal-states. Expected ["open","open","rejected","rejected","rejected"]. Observed []. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `Onto empty`. producer-summary-keeps-counts-separate. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000010"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false.

- Baseline, `nov25-ocean-replay / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: calendar-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: planning-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: follow-up-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run","/apps/forerunner/runs/calendar-discovery-run","/apps/forerunner/runs/planning-discovery-run","/apps/forerunner/runs/follow-up-discovery-run"]. Observed []. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Baseline, `nov25-authored-late-discovery / morning`. phase-outcome. Expected "deferred". Observed "started". occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000020"]. inference-count. Expected 0. Observed 1. wiki-write-count. Expected 0. Observed 1. next-dependency-check-is-before-07:00. Expected true. Observed false. nothing-from-07:00-leaks-at-05:00. Expected false. Observed true.

- Baseline, `nov25-authored-late-discovery / ready`. all-four-discoveries-read-before-brief-start. Expected ["mail-discovery-run","calendar-discovery-run","planning-discovery-run","follow-up-discovery-run"]. Observed []. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: calendar-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: planning-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: follow-up-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run","/apps/forerunner/runs/calendar-discovery-run","/apps/forerunner/runs/planning-discovery-run","/apps/forerunner/runs/follow-up-discovery-run"]. Observed []. wiki-coverage-count-in-prompt. Expected 2. Observed null. authored-wiki-evidence-order. Expected ["Reviewed field notes","Documented the handoff"]. Observed []. authored-wiki-revision-links. Expected [["doc-authored",3],["legacy-authored",2]]. Observed []. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Candidate, `nov25-authored-late-discovery / ready`. model-does-not-invent-wiki-author. Expected []. Observed ["You authored 2 Wiki revisions yesterday, including a legacy graph revision in the fixture-team Wiki documenting the handoff, saved just before midnight.","Confirm the field handoff documentation in the fixture-team Wiki is complete enough to send, since you authored a legacy graph revision about it just before midnight."].

- Baseline, `nov25-partial-recovery / partial`. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run"]. Observed []. partial-gaps-carry-failed-leaf-running-disabled-and-unread-sources. Expected [true,true,true,true,true]. Observed [false,false,false,false,false].

- Baseline, `nov25-partial-recovery / recovered`. requested-half-open-chicago-window. Expected true. Observed false. only-successful-discovery-receipts-in-prompt. Expected ["Discovery: mail-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: calendar-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: planning-discovery completed this morning: 2 analyzed entries, 0 saved suggestions.","Discovery: follow-up-discovery completed this morning: 2 analyzed entries, 0 saved suggestions."]. Observed []. discovery-citations-match-reserved-result-ids. Expected ["/apps/forerunner/runs/mail-discovery-run","/apps/forerunner/runs/calendar-discovery-run","/apps/forerunner/runs/planning-discovery-run","/apps/forerunner/runs/follow-up-discovery-run"]. Observed []. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. model-does-not-claim-four-commits-from-batch-state. Expected false. Observed true.

- Baseline, `nov25-partial-recovery / retry`. occurrence-workflow-start. Expected []. Observed ["00000000-0000-4000-8000-000000000031"]. existing-revision-retained. Expected ["saved",1]. Observed ["unchanged",1]. terminal-reservation-read-without-a-second-collection. Expected [true,0]. Observed [false,1].

- Baseline, `nov25-empty-confirmed / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false. model-cites-checked-zero-wiki-activity. Expected true. Observed false.

- Baseline, `nov25-auth-isolation / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null. onto-counts-present-before-model. Expected true. Observed false.

- Baseline, `nov01-chicago-dst / morning`. requested-half-open-chicago-window. Expected true. Observed false. wiki-coverage-count-in-prompt. Expected 0. Observed null.
