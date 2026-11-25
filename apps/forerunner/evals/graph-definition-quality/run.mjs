import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { model, limits, requestOptions, modelRevisionOf } from './experiments/config.mjs';
import { prepare } from './fixture.mjs';
import { runPair } from '@ai-outfitter/box/eval/paired';

const project = fileURLToPath(new URL('.', import.meta.url));
const schema = process.env.EVAL_SCHEMA || join(project, 'evals/connected-discovery/schema-authored.json');
await runPair({
  project, model, limits, requestOptions, modelRevisionOf,
  prepare: (arm, fixture, prompt) => prepare(arm, fixture, prompt, schema),
  resultsDir: process.env.EVAL_RESULTS_DIR || join(project, 'results'),
});
