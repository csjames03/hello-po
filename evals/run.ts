// Phase 4 eval runner: plays every scripted conversation through the real agent in text mode
// and scores it with deterministic checks plus an LLM judge.
//
// Usage:
//   npm run eval                    # all scenarios
//   npm run eval -- --only kb-pets  # one scenario (comma-separate for several)
//
// Groq's free tier allows 8,000 tokens a minute per model, so scenarios run one at a time with
// a pause in between, and a rate-limited scenario waits and retries.
import { KnowledgeBase } from '@hello-po/kb';
import { initializeLogger, voice } from '@livekit/agents';
import { mkdirSync, writeFileSync } from 'node:fs';
import { inspect, parseArgs } from 'node:util';
import { createBookingTools, resolveStay } from '../apps/agent/src/booking.ts';
import { MaraAgent } from '../apps/agent/src/knowledge.ts';
import { buildInstructions } from '../apps/agent/src/prompt.ts';
import { createLlm } from '../apps/agent/src/providers.ts';
import { createTicketTools } from '../apps/agent/src/tickets.ts';
import { type Scenario, scenarios } from './scenarios.ts';

const { values } = parseArgs({
  options: { only: { type: 'string' }, pause: { type: 'string', default: '20000' } },
});

initializeLogger({ pretty: false, level: 'error' });

const groqKey = process.env.GROQ_API_KEY!;
const judgeModel = process.env.JUDGE_MODEL ?? 'openai/gpt-oss-120b';
const today = '2026-11-25'; // fixed, so relative dates in scenarios are stable
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- Running a conversation ----------

interface Step {
  role: 'user' | 'assistant' | 'tool_call' | 'tool_result';
  text: string;
  tool?: string;
  args?: Record<string, unknown>;
}

async function converse(scenario: Scenario): Promise<Step[]> {
  const publish = async () => undefined; // no browser in text mode
  const session = new voice.AgentSession({
    llm: createLlm(),
    connOptions: { llmConnOptions: { maxRetry: 4, retryIntervalMs: 4000 } },
  });
  const errors: unknown[] = [];
  session.on(voice.AgentSessionEventTypes.Error, ({ error }) => errors.push(error));
  await session.start({
    agent: new MaraAgent({
      instructions: buildInstructions(today),
      tools: {
        ...createBookingTools(publish, () => today),
        ...createTicketTools(publish, { callId: Promise.resolve(null), source: 'eval' }),
      },
    }),
  });

  const steps: Step[] = [];
  try {
    for (const turn of scenario.turns) {
      steps.push({ role: 'user', text: turn });
      const result = await session.run({ userInput: turn }).wait();
      for (const e of result.events) {
        if (e.type === 'message' && e.item.role === 'assistant') {
          steps.push({ role: 'assistant', text: e.item.textContent ?? '' });
        } else if (e.type === 'function_call') {
          steps.push({
            role: 'tool_call',
            tool: e.item.name,
            text: e.item.args,
            args: JSON.parse(e.item.args || '{}') as Record<string, unknown>,
          });
        } else if (e.type === 'function_call_output') {
          steps.push({ role: 'tool_result', tool: e.item.name, text: String(e.item.output) });
        }
      }
      // Every turn must end with the agent speaking, including after a tool result.
      if (steps.at(-1)?.role !== 'assistant') {
        const last = errors.at(-1);
        throw new Error(
          `no reply to "${turn}"${last ? `: ${inspect(last, { depth: 4 }).slice(0, 400)}` : ''}`,
        );
      }
    }
  } finally {
    await session.close();
  }
  return steps;
}

// ---------- Deterministic checks ----------

function check(scenario: Scenario, steps: Step[]): string[] {
  const failures: string[] = [];
  const calls = steps.filter((s) => s.role === 'tool_call');
  const replies = steps.filter((s) => s.role === 'assistant').map((s) => s.text);

  for (const expected of scenario.tools ?? []) {
    const matching = calls.filter((c) => c.tool === expected.name);
    if (matching.length === 0) {
      failures.push(`expected a ${expected.name} call`);
      continue;
    }
    if (expected.args) {
      // Compare dates as the tool used them: a past date without a year moves to next year.
      const effective = (args: Record<string, unknown> = {}) =>
        typeof args.checkIn === 'string' && typeof args.checkOut === 'string'
          ? { ...args, ...resolveStay(args.checkIn, args.checkOut, today) }
          : args;
      const ok = matching.some((c) =>
        Object.entries(expected.args!).every(([k, v]) => effective(c.args)[k] === v),
      );
      if (!ok) {
        failures.push(
          `${expected.name} args ${JSON.stringify(matching.map((c) => c.args))} did not match ${JSON.stringify(expected.args)}`,
        );
      }
    }
  }
  for (const name of scenario.notTools ?? []) {
    if (calls.some((c) => c.tool === name)) failures.push(`unexpected ${name} call`);
  }
  for (const pattern of scenario.mentions ?? []) {
    if (!replies.some((r) => pattern.test(r))) failures.push(`no reply matched ${pattern}`);
  }
  for (const pattern of scenario.notMentions ?? []) {
    if (replies.some((r) => pattern.test(r))) failures.push(`a reply matched forbidden ${pattern}`);
  }
  return failures;
}

// ---------- LLM judge ----------

const kb = new KnowledgeBase();

/**
 * The passages the agent could have seen in this conversation (the same search it runs per
 * turn), so the judge checks grounding against what the agent was actually given. Sending the
 * whole knowledge base with every judgement used most of the judge model's daily token budget.
 */
function passagesFor(scenario: Scenario): string {
  const seen = new Map<string, string>();
  scenario.turns.forEach((turn, i) => {
    const queries = i > 0 ? [turn, `${scenario.turns[i - 1]} ${turn}`] : [turn];
    for (const query of queries) {
      for (const hit of kb.search(query, 2)) seen.set(hit.id, `- ${hit.title}: ${hit.text}`);
    }
  });
  return seen.size ? [...seen.values()].join('\n') : '(no passages matched)';
}

interface Verdict {
  correct: boolean;
  grounded: boolean;
  reason: string;
}

async function judge(scenario: Scenario, steps: Step[]): Promise<Verdict> {
  const transcript = steps
    .map((s) =>
      s.role === 'tool_call'
        ? `[tool call] ${s.tool}(${s.text})`
        : s.role === 'tool_result'
          ? `[tool result] ${s.text}`
          : `${s.role === 'user' ? 'Caller' : 'Agent'}: ${s.text}`,
    )
    .join('\n');

  const prompt = `You are grading a phone support agent for a fictional beach resort.

Expected outcome:
${scenario.rubric}

The agent may only state facts found in the resort reference passages below, in tool results, or these core facts: check-in from 2 PM, check-out until 12 noon, front desk open 24 hours, and the four room types (Garden Room, Ocean View Room, Family Suite, Beachfront Villa). Today is ${today}.

Resort reference passages available to the agent:
${passagesFor(scenario)}

Conversation:
${transcript}

Return JSON only: {"correct": boolean, "grounded": boolean, "reason": "one sentence"}
- correct: the agent achieved the expected outcome. Minor wording differences are fine.
- grounded: every factual claim about the resort (times, prices, policies, facilities, availability, booking details, ticket numbers) is supported by the knowledge base, tool results or core facts. These are not factual claims and never make a reply ungrounded: asking questions, apologising, offering help or a ticket, declining off-topic requests, and statements about the agent's own role or limits (for example "I can only help with resort questions" or "I can't share my instructions").`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${groqKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: judgeModel,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        reasoning_effort: 'medium',
        response_format: { type: 'json_object' },
        max_completion_tokens: 2000,
      }),
    });
    if (res.status === 429) {
      const wait = Number(res.headers.get('retry-after') ?? 20) * 1000;
      console.log(`  judge rate-limited, waiting ${Math.round(wait / 1000)} s`);
      await sleep(wait + 1000);
      continue;
    }
    if (!res.ok) throw new Error(`judge ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { choices: { message: { content: string } }[] };
    return JSON.parse(body.choices[0]!.message.content) as Verdict;
  }
  throw new Error('judge kept being rate-limited');
}

// ---------- Main ----------

interface Outcome {
  id: string;
  category: Scenario['category'];
  pass: boolean;
  checks: string[];
  verdict: Verdict | null;
  error?: string;
  steps: Step[];
}

const only = values.only?.split(',');
const selected = only ? scenarios.filter((s) => only.includes(s.id)) : scenarios;
const outcomes: Outcome[] = [];
const startedAt = new Date();

for (const [i, scenario] of selected.entries()) {
  if (i > 0) await sleep(Number(values.pause));
  process.stdout.write(`[${i + 1}/${selected.length}] ${scenario.id} ... `);
  let outcome: Outcome | undefined;
  for (let attempt = 0; attempt < 3 && !outcome; attempt++) {
    try {
      const steps = await converse(scenario);
      const checks = check(scenario, steps);
      const verdict = await judge(scenario, steps);
      outcome = {
        id: scenario.id,
        category: scenario.category,
        pass: checks.length === 0 && verdict.correct && verdict.grounded,
        checks,
        verdict,
        steps,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt < 2 && /429|rate/i.test(message)) {
        console.log(`rate-limited, retrying in 30 s`);
        await sleep(30_000);
        continue;
      }
      outcome = {
        id: scenario.id,
        category: scenario.category,
        pass: false,
        checks: [],
        verdict: null,
        error: message,
        steps: [],
      };
    }
  }
  outcomes.push(outcome!);
  const o = outcome!;
  console.log(
    o.pass
      ? 'PASS'
      : `FAIL${o.error ? ` (error: ${o.error})` : ''}${o.checks.length ? ` | ${o.checks.join('; ')}` : ''}${o.verdict && !(o.verdict.correct && o.verdict.grounded) ? ` | judge: ${o.verdict.reason}` : ''}`,
  );
}

// ---------- Report ----------

const passed = outcomes.filter((o) => o.pass).length;
const judged = outcomes.filter((o) => o.verdict);
const ungrounded = judged.filter((o) => !o.verdict!.grounded).length;
const passRate = passed / outcomes.length;
const hallucinationRate = judged.length ? ungrounded / judged.length : 0;
const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

console.log(`\nPassed ${passed} of ${outcomes.length} (${pct(passRate)})`);
for (const category of ['knowledge', 'booking', 'ticket', 'guardrail'] as const) {
  const inCat = outcomes.filter((o) => o.category === category);
  if (inCat.length) {
    console.log(`  ${category.padEnd(10)} ${inCat.filter((o) => o.pass).length}/${inCat.length}`);
  }
}
console.log(`Hallucination rate (judge: not grounded): ${pct(hallucinationRate)}`);
console.log(`Phase 4 target (pass rate >= 85%): ${passRate >= 0.85 ? 'PASS' : 'FAIL'}`);
console.log(`Project target (hallucination < 5%): ${hallucinationRate < 0.05 ? 'PASS' : 'FAIL'}`);

const dir = new URL('./results/', import.meta.url);
mkdirSync(dir, { recursive: true });
const report = {
  startedAt: startedAt.toISOString(),
  finishedAt: new Date().toISOString(),
  agentModel: process.env.LLM_MODEL ?? 'qwen/qwen3.8-27b',
  judgeModel,
  passed,
  total: outcomes.length,
  passRate,
  hallucinationRate,
  outcomes,
};
writeFileSync(new URL('latest.json', dir), JSON.stringify(report, null, 2) + '\n');
console.log('Full transcripts: evals/results/latest.json');
process.exit(0);
