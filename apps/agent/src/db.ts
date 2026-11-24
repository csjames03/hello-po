// Minimal Supabase (PostgREST) client for call and turn logs.
// Logging must never break a call, so every function swallows and logs its errors.
import { config } from './config.ts';

const enabled = Boolean(config.supabaseUrl && config.supabaseSecretKey);

function headers(): Record<string, string> {
  const key = config.supabaseSecretKey!;
  const h: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
  // Legacy service_role keys are JWTs and also need a bearer header; sb_secret_ keys must not.
  if (!key.startsWith('sb_secret_')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T | null> {
  if (!enabled) return null;
  try {
    const res = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
      method,
      headers: { ...headers(), Prefer: 'return=representation' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) {
      console.warn(`[db] ${method} ${path} failed: ${res.status} ${await res.text()}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    console.warn(`[db] ${method} ${path} error:`, err);
    return null;
  }
}

export interface TurnRow {
  call_id: string;
  turn_id: string;
  user_text: string | null;
  agent_text: string | null;
  eot_ms: number | null;
  stt_ms: number | null;
  llm_ttft_ms: number | null;
  tts_ttfb_ms: number | null;
  e2e_ms: number;
  interrupted: boolean;
}

export async function createCall(roomName: string): Promise<string | null> {
  const rows = await request<{ id: string }[]>('POST', 'calls', {
    room_name: roomName,
    stt_model: config.sttModel,
    llm_model: config.llmModel,
    tts_voice: config.ttsVoice,
  });
  return rows?.[0]?.id ?? null;
}

export async function endCall(callId: string): Promise<void> {
  await request('PATCH', `calls?id=eq.${callId}`, { ended_at: new Date().toISOString() });
}

export async function insertTurn(row: TurnRow): Promise<void> {
  await request('POST', 'turns', row);
}

export async function insertInterruption(row: {
  call_id: string;
  turn_id: string;
  stop_ms: number;
  resumed: boolean;
}): Promise<void> {
  await request('POST', 'interruptions', row);
}

export const dbEnabled = enabled;
