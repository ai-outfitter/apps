import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { model, limits } from './experiments/config.mjs';
import { prepare } from './fixture.mjs';
import { runPair } from '../../../../box/eval/paired.mjs';

const project = fileURLToPath(new URL('.', import.meta.url));
await runPair({ project, model, limits, prepare, resultsDir: process.env.EVAL_RESULTS_DIR || join(project, 'results') });
