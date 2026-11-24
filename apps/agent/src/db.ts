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

/** Inserts one row and returns it, or null if the insert failed (the error is logged). */
export async function insertRow<T = Record<string, unknown>>(
  table: string,
  row: Record<string, unknown>,
): Promise<T | null> {
  const rows = await request<T[]>('POST', table, row);
  return rows?.[0] ?? null;
}

/** Updates rows matching a PostgREST filter (e.g. "code=eq.TK-ABC12"). Returns false on failure. */
export async function updateRows(
  table: string,
  filter: string,
  values: Record<string, unknown>,
): Promise<boolean> {
  const rows = await request<unknown[]>('PATCH', `${table}?${filter}`, values);
  return Boolean(rows?.length);
}

export const dbEnabled = enabled;

/**
 * Calls a Postgres function. Unlike the logging helpers above, this throws, because a tool
 * needs to tell the model that the lookup failed rather than silently returning nothing.
 */
export async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  if (!enabled) throw new Error('Supabase is not configured');
  const res = await fetch(`${config.supabaseUrl}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(args),
  });
  const body = (await res.json()) as T | { message?: string };
  if (!res.ok) throw new Error((body as { message?: string }).message ?? `rpc ${fn} ${res.status}`);
  return body as T;
}

/** Reads rows with a PostgREST query string. Throws on failure, like rpc(). */
export async function select<T>(query: string): Promise<T[]> {
  if (!enabled) throw new Error('Supabase is not configured');
  const res = await fetch(`${config.supabaseUrl}/rest/v1/${query}`, { headers: headers() });
  if (!res.ok) throw new Error(`select ${res.status}: ${await res.text()}`);
  return (await res.json()) as T[];
}

/**
 * Keeps an HTTPS connection to Supabase open for the length of a call. Node closes idle
 * connections after about 4 s, and a fresh one from us-east costs ~700 ms, so booking tools
 * paid that on every lookup. A tiny request every 3 s keeps them at one round trip.
 * Returns a function that stops it.
 */
export function keepSupabaseWarm(intervalMs = 3000): () => void {
  if (!enabled) return () => undefined;
  const ping = () =>
    fetch(`${config.supabaseUrl}/rest/v1/room_types?select=id&limit=1`, {
      method: 'HEAD',
      headers: headers(),
    }).catch(() => undefined);
  void ping();
  const timer = setInterval(ping, intervalMs);
  return () => clearInterval(timer);
}
