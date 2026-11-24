// Minimal Supabase (PostgREST) client for the booking API. Uses the server-only secret key.
const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const key = process.env.SUPABASE_SECRET_KEY;

export const supabaseEnabled = Boolean(url && key);

export class SupabaseError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { apikey: key!, 'Content-Type': 'application/json' };
  // Legacy service_role keys are JWTs and also need a bearer header; sb_secret_ keys must not.
  if (!key!.startsWith('sb_secret_')) h.Authorization = `Bearer ${key}`;
  return h;
}

async function send<T>(method: string, path: string, body?: unknown, prefer?: string): Promise<T> {
  if (!supabaseEnabled) throw new SupabaseError(500, undefined, 'Supabase is not configured');
  const res = await fetch(`${url}/rest/v1/${path}`, {
    method,
    headers: { ...headers(), ...(prefer ? { Prefer: prefer } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const err = (data ?? {}) as { code?: string; message?: string };
    throw new SupabaseError(res.status, err.code, err.message ?? `${method} ${path} ${res.status}`);
  }
  return data as T;
}

export const rpc = <T>(fn: string, args: Record<string, unknown>) =>
  send<T>('POST', `rpc/${fn}`, args);

export const select = <T>(query: string) => send<T[]>('GET', query);

/** PATCH with return=representation; returns the rows that matched the filter. */
export const update = <T>(query: string, values: Record<string, unknown>) =>
  send<T[]>('PATCH', query, values, 'return=representation');
