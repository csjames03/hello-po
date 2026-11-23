-- Hello Po: call and turn logging (Phase 2).
-- Run once in the Supabase SQL editor, or with `supabase db push`.

create table if not exists public.calls (
  id          uuid primary key default gen_random_uuid(),
  room_name   text not null,
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  stt_model   text,
  llm_model   text,
  tts_voice   text
);

create table if not exists public.turns (
  id           bigint generated always as identity primary key,
  call_id      uuid not null references public.calls (id) on delete cascade,
  turn_id      text not null,
  user_text    text,
  agent_text   text,
  -- Stage timings in milliseconds. Null when the SDK did not report the stage.
  eot_ms       integer,  -- end of user speech -> turn committed
  stt_ms       integer,  -- end of user speech -> final transcript
  llm_ttft_ms  integer,  -- LLM request -> first token
  tts_ttfb_ms  integer,  -- first text to TTS -> first audio
  e2e_ms       integer not null, -- user stopped speaking -> agent started speaking
  interrupted  boolean not null default false,
  created_at   timestamptz not null default now()
);

create index if not exists turns_created_at_idx on public.turns (created_at desc);
create index if not exists turns_call_id_idx on public.turns (call_id);

-- Only the server (secret key) reads and writes these tables.
-- RLS with no policies blocks the public publishable/anon key entirely.
alter table public.calls enable row level security;
alter table public.turns enable row level security;
