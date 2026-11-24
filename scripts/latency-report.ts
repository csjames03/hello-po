// Prints p50 / p95 voice-to-voice latency and a per-stage breakdown from Supabase.
//
// Usage:
//   npm run latency:report                 # last 20 turns
//   npm run latency:report -- --last 50
//   npm run latency:report -- --stt flux-general-en
//   npm run latency:report -- --llm openai/gpt-oss-20b
//   npm run latency:report -- --since 2026-11-23T19:40   # only rows after a time (UTC)
//   npm run latency:report -- --local      # read logs/turns.jsonl instead of Supabase
//   npm run latency:report -- --lines docs/results/phase-2-cloud-latency.log
//                                          # parse "[latency]" lines from agent logs
import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

process.loadEnvFile(new URL('../.env', import.meta.url));

const { values } = parseArgs({
  options: {
    last: { type: 'string', default: '20' },
    stt: { type: 'string' },
    llm: { type: 'string' },
    local: { type: 'boolean', default: false },
    lines: { type: 'string' },
    since: { type: 'string' },
  },
});

interface Turn {
  e2e_ms: number;
  eot_ms: number | null;
  stt_ms: number | null;
  llm_ttft_ms: number | null;
  tts_ttfb_ms: number | null;
  interrupted: boolean;
  stt_model: string;
  llm_model: string;
}

const limit = Number(values.last);
const source = values.lines
  ? `log lines (${values.lines})`
  : values.local
    ? 'local log'
    : 'Supabase';
const turns = values.lines
  ? loadLogLines(values.lines)
  : values.local
    ? loadLocal()
    : await loadSupabase();

/** Parses lines like "[latency] total  450ms | eot    3ms | stt    0ms | llm  318ms | tts  101ms". */
function loadLogLines(path: string): Turn[] {
  const num = (v: string | undefined) => (v === undefined || v === '-' ? null : Number(v));
  const re =
    /\[latency\] total\s+(\d+)ms \| eot\s+(\d+|-)\S* \| stt\s+(\d+|-)\S* \| llm\s+(\d+|-)\S* \| tts\s+(\d+|-)\S*(.*)$/;
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => re.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      e2e_ms: Number(m[1]),
      eot_ms: num(m[2]),
      stt_ms: num(m[3]),
      llm_ttft_ms: num(m[4]),
      tts_ttfb_ms: num(m[5]),
      interrupted: (m[6] ?? '').includes('interrupted'),
      stt_model: 'see log header',
      llm_model: 'see log header',
    }))
    .slice(-limit);
}

function loadLocal(): Turn[] {
  const file = new URL('../logs/turns.jsonl', import.meta.url);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Turn)
    .filter((t) => !values.stt || t.stt_model === values.stt)
    .filter((t) => !values.llm || t.llm_model === values.llm)
    .slice(-limit)
    .reverse();
}

async function loadSupabase(): Promise<Turn[]> {
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key)
    throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env, or use --local');

  const params = new URLSearchParams({
    select:
      'e2e_ms,eot_ms,stt_ms,llm_ttft_ms,tts_ttfb_ms,interrupted,calls!inner(stt_model,llm_model)',
    order: 'created_at.desc',
    limit: String(limit),
  });
  if (values.since) params.set('created_at', `gte.${values.since}`);
  if (values.stt) params.set('calls.stt_model', `eq.${values.stt}`);
  if (values.llm) params.set('calls.llm_model', `eq.${values.llm}`);

  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;

  const res = await fetch(`${url}/rest/v1/turns?${params}`, { headers });
  if (!res.ok) throw new Error(`Supabase ${res.status}: ${await res.text()}`);
  const rows = (await res.json()) as (Omit<Turn, 'stt_model' | 'llm_model'> & {
    calls: { stt_model: string; llm_model: string };
  })[];
  return rows.map(({ calls, ...t }) => ({ ...t, ...calls }));
}

if (turns.length === 0) {
  console.log('No turns found. Make a call first.');
  await printInterruptions();
  process.exit(0);
}

// Nearest-rank percentile.
function pct(nums: number[], p: number): number | null {
  if (nums.length === 0) return null;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]!;
}

const rows: [string, keyof Turn, number | null][] = [
  ['Voice to voice (total)', 'e2e_ms', 800],
  ['End of turn', 'eot_ms', 200],
  ['STT final transcript', 'stt_ms', 150],
  ['LLM first token', 'llm_ttft_ms', 200],
  ['TTS first audio', 'tts_ttfb_ms', 150],
];

const models = [...new Set(turns.map((t) => `${t.stt_model} + ${t.llm_model}`))];
console.log(`\nHello Po latency report: last ${turns.length} turns from ${source}`);
console.log(`Models: ${models.join(', ')}`);
console.log(`Interrupted turns: ${turns.filter((t) => t.interrupted).length}\n`);

const fmt = (v: number | null) => (v === null ? '-' : `${v} ms`).padStart(9);
console.log(
  `${'Stage'.padEnd(24)}${'p50'.padStart(9)}${'p95'.padStart(9)}${'budget'.padStart(9)}   n`,
);
console.log('-'.repeat(56));
for (const [label, field, budget] of rows) {
  const nums = turns.map((t) => t[field]).filter((v): v is number => typeof v === 'number');
  console.log(
    `${label.padEnd(24)}${fmt(pct(nums, 50))}${fmt(pct(nums, 95))}${fmt(budget)}   ${nums.length}`,
  );
}

const p50 = pct(
  turns.map((t) => t.e2e_ms),
  50,
)!;
const p95 = pct(
  turns.map((t) => t.e2e_ms),
  95,
)!;
console.log('\nPhase 2 target (p50 < 1000 ms):', p50 < 1000 ? 'PASS' : 'FAIL');
console.log(
  'Project target (p50 < 800 ms, p95 < 1200 ms):',
  p50 < 800 && p95 < 1200 ? 'PASS' : 'FAIL',
);
console.log(
  '\nNote: stages can overlap (preemptive generation), so they need not sum to the total.\n' +
    'Total is measured on the agent; browser playout and network add a little more.\n',
);

await printInterruptions();

// ---------- Interruptions (barge-in stop time) ----------

interface Interruption {
  stop_ms: number;
  resumed: boolean;
}

async function loadInterruptions(): Promise<Interruption[]> {
  if (values.lines) {
    // "[interrupt] stop  180ms" or "[interrupt] paused 240ms then resumed (false interruption)"
    const re = /\[interrupt\] (stop|paused)\s+(\d+)ms/;
    return readFileSync(values.lines, 'utf8')
      .split('\n')
      .map((line) => re.exec(line))
      .filter((m): m is RegExpExecArray => m !== null)
      .map((m) => ({ stop_ms: Number(m[2]), resumed: m[1] === 'paused' }))
      .slice(-limit);
  }
  if (values.local) {
    const file = new URL('../logs/interrupts.jsonl', import.meta.url);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Interruption)
      .slice(-limit);
  }
  const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return [];
  const headers: Record<string, string> = { apikey: key };
  if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;
  const params = new URLSearchParams({
    select: 'stop_ms,resumed',
    order: 'created_at.desc',
    limit: String(limit),
  });
  if (values.since) params.set('created_at', `gte.${values.since}`);
  const res = await fetch(`${url}/rest/v1/interruptions?${params}`, { headers });
  // The table arrives with migration 0003; treat a missing table as "no data".
  if (!res.ok) return [];
  return ((await res.json()) as Interruption[]).reverse();
}

async function printInterruptions() {
  const all = await loadInterruptions();
  const real = all.filter((i) => !i.resumed).map((i) => i.stop_ms);
  const falseCount = all.length - real.length;

  console.log(
    `Interruptions: ${real.length} real, ${falseCount} false (agent paused, then resumed)`,
  );
  if (real.length === 0) {
    console.log('No interruptions recorded yet.\n');
    return;
  }
  const max = Math.max(...real);
  const under = real.filter((ms) => ms < 300).length;
  console.log(
    `Stop time: p50 ${pct(real, 50)} ms | p95 ${pct(real, 95)} ms | max ${max} ms | ` +
      `${under}/${real.length} under 300 ms`,
  );
  console.log('Phase 3 target (every stop < 300 ms):', max < 300 ? 'PASS' : 'FAIL');
  console.log(
    'Stop time = caller starts speaking over the agent -> agent audio paused, measured on the agent.\n',
  );
}
