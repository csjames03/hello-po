-- Hello Po: support tickets (including human handoffs) and per-turn caller sentiment (Phase 4b).

create table if not exists public.tickets (
  id           uuid primary key default gen_random_uuid(),
  code         text not null unique, -- e.g. TK-7Q2MX, read out to the caller
  call_id      uuid references public.calls (id) on delete set null,
  call_room    text,
  category     text not null check (category in ('handoff', 'complaint', 'request', 'question', 'booking')),
  priority     text not null default 'normal' check (priority in ('normal', 'urgent')),
  caller_name  text,
  contact      text, -- phone number or email for the callback
  summary      text not null,
  status       text not null default 'open' check (status in ('open', 'in_progress', 'closed')),
  source       text not null default 'call' check (source in ('call', 'eval')),
  created_at   timestamptz not null default now()
);

create index if not exists tickets_created_at_idx on public.tickets (created_at desc);
create index if not exists tickets_status_idx on public.tickets (status);

-- One row per caller turn, scored off the reply path so it adds no latency.
create table if not exists public.turn_sentiments (
  id          bigint generated always as identity primary key,
  call_id     uuid references public.calls (id) on delete cascade,
  message_id  text not null,
  text        text not null,
  score       numeric(3, 2) not null check (score between -1 and 1),
  label       text not null check (label in ('negative', 'neutral', 'positive')),
  created_at  timestamptz not null default now()
);

create index if not exists turn_sentiments_call_id_idx on public.turn_sentiments (call_id);
create index if not exists turn_sentiments_created_at_idx on public.turn_sentiments (created_at desc);

alter table public.tickets enable row level security;
alter table public.turn_sentiments enable row level security;

grant select, insert, update, delete on public.tickets, public.turn_sentiments to service_role;
