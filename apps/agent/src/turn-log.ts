// Appends each turn to logs/turns.jsonl at the repo root, so latency can be
// analysed locally (npm run latency:report -- --local) even without Supabase.
import { appendFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import type { InterruptRecord } from './interruptions.ts';
import type { TurnLatency } from './latency.ts';

const dir = fileURLToPath(new URL('../../../logs/', import.meta.url));

export async function appendLocalTurn(turn: TurnLatency, roomName: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      room: roomName,
      stt_model: config.sttModel,
      llm_model: config.llmModel,
      tts_voice: config.ttsVoice,
      e2e_ms: turn.totalMs,
      eot_ms: turn.eotMs,
      stt_ms: turn.sttMs,
      llm_ttft_ms: turn.llmFirstTokenMs,
      tts_ttfb_ms: turn.ttsFirstAudioMs,
      interrupted: turn.interrupted,
    };
    await appendFile(`${dir}turns.jsonl`, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn('[turn-log] write failed:', err);
  }
}

export async function appendLocalInterrupt(r: InterruptRecord, roomName: string): Promise<void> {
  try {
    await mkdir(dir, { recursive: true });
    const record = {
      ts: new Date().toISOString(),
      room: roomName,
      stop_ms: r.stopMs,
      resumed: r.resumed,
    };
    await appendFile(`${dir}interrupts.jsonl`, JSON.stringify(record) + '\n');
  } catch (err) {
    console.warn('[turn-log] write failed:', err);
  }
}
