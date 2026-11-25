import { createServer } from 'node:http';
import { once } from 'node:events';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyAgent } from '../eval/read-only-agent.mjs';

test('records usage for tool and final turns and enforces the tool budget', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
    const choice = requests.length === 1
      ? { finish_reason: 'tool_calls', message: { tool_calls: [{ id: 'a', function: { name: 'lookup', arguments: '{}' } }] } }
      : { finish_reason: 'stop', message: { content: '{}' } };
    response.end(JSON.stringify({ model: 'test-model', choices: [choice],
      usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } }));
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    assert(address && typeof address === 'object');
    const receipts = [];
    const agent = readOnlyAgent({
      name: 'test', model: 'test-model', modelRevision: null, receipts,
      endpoint: `http://127.0.0.1:${address.port}`,
      requestOptions: { provider_option: true, max_tokens: 999 },
      limits: { modelCalls: 2, toolCalls: 1, tokensPerCall: 30, temperature: 0, seed: 7 },
      prepare: () => ({ inputs: {}, messages: [], tools: [{ type: 'function' }],
        execute: () => ({ ok: true }), grade: () => ({ passed: true }) }),
    });
    const result = await agent.run('.', { prompt: '', model: 'test-model', timeout: 5000, apiKey: '' });
    assert.equal(result.success, true);
    assert.deepEqual(result.usage, { inputTokens: 22, outputTokens: 4, totalTokens: 26 });
    assert.equal(receipts[0].toolCalls, 1);
    assert.ok(requests.every(body => body.provider_option === true && body.max_tokens === 30));
    assert.ok(requests.every(body => !('chat_template_kwargs' in body)));
    assert.equal(requests[1].tools, undefined);
    assert.deepEqual(requests[1].response_format, { type: 'json_object' });
    assert.equal((requests[1].messages as { role: string }[]).at(-1)?.role, 'user');
    assert.deepEqual((requests[1].messages as unknown[]).at(-2),
      { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' });
  } finally {
    server.close();
  }
});

test('refuses to score after a stale model, excessive calls, or a deadline', async () => {
  const toolCall = { id: 'a', function: { name: 'lookup', arguments: '{}' } };
  const scenarios = [
    { fault: /different model/, model: 'other-model', message: { content: '{}' } },
    { fault: /one-tool-per-turn/, model: 'test-model', message: { tool_calls: [toolCall, { ...toolCall, id: 'b' }] } },
    { fault: /deadline/, model: 'test-model', message: {}, delay: 150 },
  ];
  for (const { fault, model, message, delay } of scenarios) {
    const server = createServer(async (_request, response) => {
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      response.end(JSON.stringify({ model, choices: [{ message, finish_reason: 'stop' }] }));
    }).listen(0, '127.0.0.1');
    await once(server, 'listening');
    try {
      const address = server.address();
      assert(address && typeof address === 'object');
      const receipts = [];
      const agent = readOnlyAgent({
        name: 'test', model: 'test-model', modelRevision: null, receipts,
        endpoint: `http://127.0.0.1:${address.port}`,
        limits: { modelCalls: 2, toolCalls: 1, tokensPerCall: 30, temperature: 0, seed: 7 },
        prepare: () => ({
          inputs: {}, messages: [], tools: [{ type: 'function' }],
          execute: () => assert.fail('invalid provider response must not execute tools'),
          grade: () => assert.fail('invalid provider response must not be graded'),
        }),
      });
      const options = { prompt: '', model: 'test-model', timeout: delay ? 300 : 5000, apiKey: '' };
      await assert.rejects(agent.run('.', { ...options, model: 'unpinned' }), /must pin/);
      const result = await agent.run('.', options);
      assert.equal(result.success, false);
      assert.ok(result.error);
      assert.match(result.error, fault);
      assert.equal(receipts.length, 1);
      assert.equal(receipts[0].grade, undefined);
    } finally {
      server.close();
    }
  }
});

test('pair rejects mismatched experiment settings before running either arm', async () => {
  const { assertCompatiblePair } = await import('../eval/paired.mjs');
  const names = ['baseline', 'candidate'];
  const configs = names.map(agent => ({ agent, model: 'test-model', timeout: 75, runs: 1, earlyExit: false }));
  assert.doesNotThrow(() => assertCompatiblePair(configs, names, 'test-model', { timeoutSeconds: 75 }));
  for (const mismatch of [{ model: 'other' }, { timeout: 30 }, { runs: 2 }, { earlyExit: true }]) {
    assert.throws(() => assertCompatiblePair([configs[0], { ...configs[1], ...mismatch }], names, 'test-model',
      { timeoutSeconds: 75 }), /same pinned limits/);
  }
});
