-- Hello Po: interruption (barge-in) measurements (Phase 3).

create table if not exists public.interruptions (
  id          bigint generated always as identity primary key,
  call_id     uuid not null references public.calls (id) on delete cascade,
  turn_id     text not null,
  -- Caller starts speaking over the agent -> agent audio stops, in milliseconds.
  stop_ms     integer not null,
  -- True if the agent paused but resumed the same reply (a false interruption).
  resumed     boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists interruptions_created_at_idx on public.interruptions (created_at desc);
create index if not exists interruptions_call_id_idx on public.interruptions (call_id);

alter table public.interruptions enable row level security;
grant select, insert, update, delete on table public.interruptions to service_role;
