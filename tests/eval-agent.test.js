import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG } from '../src/config.js';
import { createAgent, sanitizeHistory } from '../src/agent/loop.js';
import { validateToolArguments, stringifyToolResult } from '../src/agent/tools.js';

const originalFetch = globalThis.fetch;
const originalConfig = { ...CONFIG, timeframes: [...CONFIG.timeframes] };

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.assign(CONFIG, originalConfig, { timeframes: [...originalConfig.timeframes] });
});

describe('eval: agent loop (no network LLM)', () => {
  it('returns the no-key message and rolls nothing back on missing credentials', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'auto', AI_API_KEY: '', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' });
    const agent = createAgent({ system: 'rules', tools: [], history: [] });
    const out = await agent.say('hello');
    assert.match(out.content, /AI key set nist/);
    assert.equal(agent.history.length, 2); // user + assistant
  });

  it('rolls back history on provider failure', async () => {
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://example.test/v1', AI_MODEL: 'fixed-model', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' });
    const agent = createAgent({ system: 'rules', tools: [], history: [{ role: 'user', content: 'earlier' }, { role: 'assistant', content: 'noted' }] });
    globalThis.fetch = async () => ({ ok: false, status: 400, text: async () => 'invalid_request_error' });
    const out = await agent.say('set timeframes');
    assert.equal(out.error, true);
    assert.equal(agent.history.length, 2);
  });

  it('executes OpenAI tool calls and returns final text', async () => {
    let calls = 0;
    let round = 0;
    Object.assign(CONFIG, { AI_PROVIDER: 'openai', AI_API_KEY: 'test-key', AI_BASE_URL: 'https://example.test/v1', AI_MODEL: 'fixed-model', ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '' });
    globalThis.fetch = async () => {
      round += 1;
      const body = round === 1
        ? { choices: [{ message: { content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: JSON.stringify({ value: 1 }) } }] } }] }
        : { choices: [{ message: { content: 'done' } }] };
      return { ok: true, json: async () => body };
    };
    const agent = createAgent({
      system: 'rules',
      tools: [{ name: 'probe', parameters: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }, handler: async () => { calls += 1; return { ok: true }; } }],
      maxRounds: 3,
    });
    const out = await agent.say('run probe');
    assert.equal(calls, 1);
    assert.equal(out.content, 'done');
  });

  it('drops orphan tool results when window cuts the assistant call', () => {
    const history = [
      { role: 'user', content: 'set tf' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'set_tf', arguments: { tf: '5m' } } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'set_tf', content: { ok: true } },
      { role: 'assistant', content: 'done' },
    ];
    const cut = sanitizeHistory(history, 2);
    assert.ok(!cut.some(m => m.role === 'tool'));
  });

  it('validates tool args and serializes results', () => {
    assert.throws(() => validateToolArguments({ type: 'object', required: ['symbol'] }, {}), /missing required/);
    assert.equal(stringifyToolResult(undefined), '{"ok":true}');
    assert.equal(stringifyToolResult({ x: 'y' }), '{"x":"y"}');
  });
});
