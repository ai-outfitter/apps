# Workshop motion eval

A robotics builder needs to see what drives an assembly and where a carried part ends up. These Tier 3 fixtures exercise Workshop's native joints, couplings, operation playback and handoffs. The screw-driven transfer is a focused step toward Tier 4 in the [Workshop vision](../../docs/vision.md).

| Case | Source and purpose | Playback checks |
| --- | --- | --- |
| Spinning wheel | Synthetic CAD-plan envelope adapted from the [spinning-wheel example](../../examples/spinning-wheel). A robotics team demonstrates a retained wheel. | The wheel turns one positive revolution, the cap stays fixed and the browser loops. |
| Gear pair | Synthetic CAD-plan envelopes adapted from the [12:24 gear-pair example](../../examples/gear-pair). A robotics team demonstrates a reduction stage. | One driver track and a native −0.5 coupling turn the follower in the opposite direction. The browser stops at the end. |
| Screw-driven transfer rig | Original synthetic bench model. A chamber robotics team demonstrates moving a payload between workstations. | The motor shaft and lead screw turn together. Pitch converts rotation to carriage travel. The payload follows the carriage until release and remains at the drop position while the carriage returns. |

The synthetic geometry includes visible rotation witnesses and simplified part envelopes. These checks cover kinematics and the rendered poses of those envelopes. Gear tooth contact, thread engagement, swept clearance, fabrication, gravity and physical hardware acceptance remain unverified. The [installed jaw cycle](../../tests/operation-playback.browser.spec.ts) separately exercises opposed jaws and an installed child operation. This suite does not load any private model or write to a live Workshop.

## Replay

From the repository root after `npm ci`:

```sh
suite=apps/workshop/agent-evals/motion
node --import tsx --test apps/workshop/tests/motion-eval.unit.test.ts
node --import tsx "$suite/regrade.ts" "$suite/evidence/spark-2026-11-26-r4.json"
npm --workspace @ai-outfitter/app-workshop run test:e2e -- \
  motion-eval.browser.spec.ts operation-playback.browser.spec.ts
```

The browser test saves each authored reference fixture and the recorded Spark transfer-rig candidate to a disposable local Workshop Worker. It checks actual Three.js scene transforms when the operator seeks from the modeled-check panel, and then runs the Play operation button against the browser clock. Reports and frames land in Workshop's Playwright test-results directory. Chromium must be installed. The shared Playwright config accepts `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` for systems with packaged Chromium.

The same grader and regrade run inside the local Workshop Box image with a read-only mount and disabled networking. See [building the Box](../../box/README.md). The commands below use its cached local image name.

```sh
podman run --rm --userns=keep-id --network=none --read-only \
  -v "$PWD:/replay:ro" -w /replay localhost/outfitter/workshop-box:dev \
  node --import tsx --test apps/workshop/tests/motion-eval.unit.test.ts
podman run --rm --userns=keep-id --network=none --read-only \
  -v "$PWD:/replay:ro" -w /replay localhost/outfitter/workshop-box:dev \
  node --import tsx "$suite/regrade.ts" "$suite/evidence/spark-2026-11-26-r4.json"
```

The Box commands execute the verifier in the image. They do not start the Box service stack. The browser command runs the operational Workshop Worker build locally, and the model command below uses the existing Box read-only Vercel Agent Eval adapter to call the LAN inference server.

```sh
node --env-file=/path/to/.env.spark --import tsx "$suite/run.ts" /tmp/workshop-motion-spark.json
```

The Spark settings use `SPARK_BASE_URL` and optional `SPARK_AUTHORIZATION` from the [Workshop settings example](../.env.example). Agent Eval sends only the synthetic prompt, part names, joint types, playback mode and duration. The model authors tracks, couplings and handoffs without tool access. The deterministic verifier keeps expected transforms and the reference program outside the prompt. A passing model run requires the native drive chain and handoffs, expected unwrapped driver angles at all breakpoints, and the expected poses evaluated through Workshop's installed-operation implementation.

## Results from 2026-11-26

| Evidence | Result |
| --- | --- |
| [Browser](evidence/browser) | Three reference fixtures passed 17 rendered witness checks. The Spark transfer-rig candidate and the existing installed jaw cycle also passed. |
| [Workshop Box](evidence/box-2026-11-26.json) | Three reference fixtures passed. Six negative controls were rejected. All three candidates in the final Spark receipt passed offline regrade. |
| [Spark, first prompt](evidence/spark-2026-11-26-r1.json) | 2/3 passed. The gear candidate calculated −0.5, then included empty tracks on the fixed base and the driven gear. Workshop could not play that candidate. |
| [Spark, clarified prompt](evidence/spark-2026-11-26-r2.json) | 3/3 passed. The prompt explicitly required at least two keys per direct track and omission of fixed parts and followers from `tracks`. |
| [Spark, runner and receipt verification](evidence/spark-2026-11-26-r4.json) | 3/3 passed after the runner gained source fingerprints and automatic redaction. The [intermediate rerun](evidence/spark-2026-11-26-r3.json) also passed 3/3. |

Spark used `GLM-5.3-Flash-EXL3` on the DGX Spark. The receipts preserve the observed model, provider runtime fingerprint, timing, token usage, prompt and fixture hashes, final JSON, and grades. The checkpoint revision was unavailable. The first receipt describes the earlier source files by hash. The committed grader also rejects its empty tracks, with schema diagnostics in place of the original exception. The runner omits provider IDs, endpoint, credentials and reasoning from saved receipts. The browser replays the transfer output from the second attempt.
