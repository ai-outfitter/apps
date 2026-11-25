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
      limits: { modelCalls: 2, toolCalls: 1, tokensPerCall: 30, temperature: 0, seed: 7 },
      prepare: () => ({ inputs: {}, messages: [], tools: [{ type: 'function' }],
        execute: () => ({ ok: true }), grade: () => ({ passed: true }) }),
    });
    const result = await agent.run('.', { prompt: '', model: 'test-model', timeout: 5000, apiKey: '' });
    assert.equal(result.success, true);
    assert.deepEqual(result.usage, { inputTokens: 22, outputTokens: 4, totalTokens: 26 });
    assert.equal(receipts[0].toolCalls, 1);
    assert.equal(requests[1].tools, undefined);
    assert.deepEqual(requests[1].response_format, { type: 'json_object' });
    assert.equal((requests[1].messages as { role: string }[]).at(-1)?.role, 'user');
    assert.deepEqual((requests[1].messages as unknown[]).at(-2),
      { role: 'tool', tool_call_id: 'a', content: '{"ok":true}' });
  } finally {
    server.close();
  }
});
