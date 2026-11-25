import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import packageInfo from '@vercel/agent-eval/package.json' with { type: 'json' };
import { formatResultsTable, loadAllFixtures, loadConfig, registerAgent, runExperiment } from '@vercel/agent-eval';
import { readOnlyAgent } from './read-only-agent.mjs';

export function assertCompatiblePair(configs, agents, model, limits) {
  if (configs.some((config, index) => config.agent !== agents[index] || config.model !== model
      || config.runs !== 1 || config.earlyExit || config.timeout !== limits.timeoutSeconds)) {
    throw new Error('Pair configurations must use the registered adapters and the same pinned limits');
  }
}

/** Keep the runner and limits identical, changing only the fixture's prepared context. */
export async function runPair({ project, resultsDir, model, limits, prepare, requestOptions, modelRevisionOf }) {
  const base = process.env.EVAL_BASE_URL;
  if (!base) throw new Error('Set EVAL_BASE_URL to a trusted OpenAI-compatible /v1 endpoint');
  const apiKey = process.env.EVAL_API_KEY ?? '';
  const response = await fetch(`${base.replace(/\/$/, '')}/models`, {
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!response.ok) throw new Error(`Model discovery HTTP ${response.status}`);
  const advertised = (await response.json()).data.find(({ id }) => id === model);
  if (!advertised) throw new Error(`Endpoint does not advertise ${model}`);
  const modelRevision = modelRevisionOf?.(advertised) ?? null;
  const { fixtures, errors } = loadAllFixtures(join(project, 'evals'));
  if (errors.length) throw new AggregateError(errors, 'Invalid evaluation fixtures');
  if (!fixtures.length) throw new Error('No evaluation fixtures found');

  const arms = ['baseline', 'candidate'];
  const schedule = fixtures.map((fixture, index) => ({
    fixture, arms: index % 2 === 0 ? arms : [...arms].reverse(),
  }));
  const pair = { version: 2, runner: `Vercel Agent Eval ${packageInfo.version}`, runtime: process.version,
    order: schedule.map(({ fixture, arms }) => ({ fixture: fixture.name, arms })), runs: {} };
  // A unique results directory prevents concurrent or interrupted reruns from overwriting receipts.
  await mkdir(resultsDir, { recursive: true });
  const pairDir = join(resultsDir, new Date().toISOString().replaceAll(':', '-'));
  await mkdir(pairDir);
  const agents = arms.map((arm) => {
    const receipts = [];
    pair.runs[arm] = receipts;
    const agent = readOnlyAgent({
      name: `read-only-${arm}`, model, limits, modelRevision, receipts, requestOptions,
      endpoint: `${base.replace(/\/$/, '')}/chat/completions`,
      prepare: (fixture, prompt) => prepare(arm, fixture, prompt),
    });
    registerAgent(agent);
    return agent.name;
  });
  const configs = await Promise.all(arms.map((arm) => loadConfig(join(project, 'experiments', `${arm}.ts`))));
  assertCompatiblePair(configs, agents, model, limits);
  try {
    for (const { fixture, arms: order } of schedule) {
      for (const arm of order) {
        const results = await runExperiment({ config: configs[arms.indexOf(arm)], fixtures: [fixture], apiKey,
          resultsDir: pairDir, experimentName: `${arm}/${fixture.name}` });
        console.log(formatResultsTable(results));
      }
    }
  } finally {
    await writeFile(join(pairDir, 'pair.json'), `${JSON.stringify(pair, null, 2)}\n`);
    console.log(`Pair receipt: ${pairDir}/pair.json`);
  }
  if (arms.some((arm) => pair.runs[arm].length !== fixtures.length || pair.runs[arm].some(({ error }) => error))) {
    throw new Error('Incomplete model run. See the pair receipt.');
  }
}
