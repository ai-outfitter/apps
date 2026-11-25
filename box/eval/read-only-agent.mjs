// A custom Agent Eval adapter for public, replayable tasks with in-memory tools.
import { performance } from 'node:perf_hooks';

const finalInstruction = {
  role: 'user',
  content: 'Tool lookup is complete. Submit the requested final JSON object using the evidence and lookup results.',
};

export function readOnlyAgent({ name, model, endpoint, prepare, limits, modelRevision, receipts, requestOptions }) {
  return {
    name,
    displayName: name,
    definition: { name, displayName: name, defaultModel: model },
    getApiKeyEnvVar: () => 'EVAL_API_KEY',
    getDefaultModel: () => model,
    async run(fixture, options) {
      if (options.model !== model) throw new Error('The experiment must pin the configured model');
      const { messages, tools, execute, grade, inputs } = await prepare(fixture, options.prompt);
      const initialMessages = structuredClone(messages);
      const started = performance.now();
      const receipt = {
        version: 1, startedAt: new Date().toISOString(), model, modelRevision, limits,
        inputs, initialMessages, tools, turns: [], modelCalls: 0, toolCalls: 0,
      };
      receipts.push(receipt);
      const signal = AbortSignal.any([
        AbortSignal.timeout(options.timeout - 250),
        ...(options.signal ? [options.signal] : []),
      ]);
      try {
        for (let turn = 0; turn < limits.modelCalls; turn++) {
          const canCall = turn + 1 < limits.modelCalls && receipt.toolCalls < limits.toolCalls;
          receipt.modelCalls++;
          const response = await fetch(endpoint, {
            method: 'POST',
            redirect: 'error',
            signal,
            headers: {
              'content-type': 'application/json',
              ...(options.apiKey ? { authorization: `Bearer ${options.apiKey}` } : {}),
            },
            body: JSON.stringify({
              ...requestOptions,
              model, messages: canCall ? messages : [...messages, finalInstruction],
              temperature: limits.temperature, seed: limits.seed,
              max_tokens: limits.tokensPerCall,
              ...(canCall
                ? { tools, parallel_tool_calls: false }
                : { response_format: { type: 'json_object' } }),
            }),
          });
          if (!response.ok) throw new Error(`Inference HTTP ${response.status}`);
          const result = await response.json();
          const choice = result.choices?.[0];
          const step = {
            id: result.id, model: result.model, fingerprint: result.system_fingerprint,
            usage: result.usage, finishReason: choice?.finish_reason, message: choice?.message,
            offeredTools: canCall, finalInstruction: canCall ? undefined : finalInstruction, toolResults: [],
          };
          receipt.turns.push(step);
          if (result.model !== model) throw new Error('Provider returned a different model');
          if (!choice?.message) throw new Error('Provider returned no assistant message');
          const { content, tool_calls: calls = [] } = choice.message;
          if (!calls.length) {
            receipt.output = content;
            if (choice.finish_reason !== 'stop') throw new Error(`Incomplete reply: ${choice.finish_reason}`);
            if (typeof content !== 'string' || !content.trim()) throw new Error('Provider returned no final text');
            receipt.grade = grade(content);
            break;
          }
          receipt.toolCalls += calls.length;
          if (!canCall || calls.length !== 1) throw new Error('The model exceeded the one-tool-per-turn limit');
          messages.push({ role: 'assistant', content, tool_calls: calls });
          const call = calls[0];
          const toolResult = {
            role: 'tool', tool_call_id: call.id,
            content: JSON.stringify(execute(call.function?.name, call.function?.arguments)),
          };
          step.toolResults.push(toolResult);
          messages.push(toolResult);
        }
      } catch (error) {
        receipt.error = signal.aborted ? 'Inference deadline reached' : error.message;
      }
      receipt.wallMs = Math.round(performance.now() - started);
      if (receipt.turns.length === receipt.modelCalls && receipt.turns.every(
        ({ usage }) => ['prompt_tokens', 'completion_tokens', 'total_tokens'].every((key) => Number.isInteger(usage?.[key])),
      )) {
        receipt.usage = {
          inputTokens: receipt.turns.reduce((sum, step) => sum + step.usage.prompt_tokens, 0),
          outputTokens: receipt.turns.reduce((sum, step) => sum + step.usage.completion_tokens, 0),
          totalTokens: receipt.turns.reduce((sum, step) => sum + step.usage.total_tokens, 0),
        };
      }
      const success = receipt.grade?.passed ?? false;
      return {
        success,
        duration: receipt.wallMs,
        observedModel: receipt.turns[0]?.model,
        usage: receipt.usage,
        output: receipt.output ?? '',
        error: receipt.error,
        testResult: receipt.grade && { success, output: JSON.stringify(receipt.grade, null, 2) },
        transcript: receipt.turns.map((step) => JSON.stringify(step)).join('\n'),
      };
    },
  };
}
