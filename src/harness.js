// harness.js — drives the agent from outside the chat UIs.
// ----------------------------------------------------------------
// Each line on stdin is JSON (or plain text); each reply is one JSON line on
// stdout, so eval/test tooling can drive the agent with no terminal UI:
//
//   {"id":1,"message":"what is the balance?"}
//     -> {"id":1,"ok":true,"reply":"...","rounds":1,"provider":"openai"}
//
// Logs go to stderr so stdout stays clean JSONL.
//
// Run standalone:  node src/harness.js     (or: npm run harness)
//
// NOTE: the harness owns stdin, so it cannot run in the same process as the
// interactive TUI (the TUI also needs stdin).
import readline from 'node:readline';

export function startHarness({ say, input = process.stdin, output = process.stdout, log = console.log }) {
  const rl = readline.createInterface({ input });
  const send = obj => output.write(`${JSON.stringify(obj)}\n`);

  rl.on('line', async line => {
    const text = line.trim();
    if (!text) return;

    let message = text;
    let id = null;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        message = String(parsed.message ?? parsed.text ?? '');
        id = parsed.id ?? null;
      }
    } catch {
      // plain text — treat the whole line as the message
    }

    if (!message) {
      send({ id, ok: false, error: 'message is empty' });
      return;
    }

    try {
      const out = await say(message);
      const reply = out && out.reply !== undefined ? out.reply : String(out?.content ?? out);
      send({ id, ok: true, reply, rounds: out?.rounds, provider: out?.provider });
    } catch (error) {
      send({ id, ok: false, error: error.message || String(error) });
    }
  });

  log('[harness] ready — one JSON per line: {"message":"..."}');

  return {
    stop() { try { rl.close(); } catch {} },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const log = (...args) => console.error(...args); // stdout is JSONL only
  const { buildRuntime } = await import('./agent/runtime.js');
  const { detectProviders } = await import('./agent/config.js');

  const { agent, tools } = await buildRuntime();
  const { handleAgentCommand } = await import('./agent-commands.js');
  const provider = detectProviders();

  startHarness({
    log,
    say: async text => {
      // Slash commands are answered locally, exactly like the TUI and Telegram,
      // so probing them does not burn an LLM round-trip.
      if (/^\/[a-z]/i.test(text)) {
        const handled = await handleAgentCommand(text, { agent, tools, say: t => agent.say(t) });
        if (handled?.handled) return { reply: handled.reply, rounds: 0, provider };
      }
      const before = agent.history.length;
      const reply = await agent.say(text);
      return {
        reply: reply.content,
        error: Boolean(reply.error),
        rounds: Math.max(1, (agent.history.length - before) / 2),
        provider,
      };
    },
  });
}