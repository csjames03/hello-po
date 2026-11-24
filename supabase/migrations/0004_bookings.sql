-- Hello Po: room inventory, bookings, and 10-minute payment holds (Phase 4a).
--
-- Rooms and the demo's random bookings are seeded from data/*.json by `npm run seed:bookings`.
-- A booking starts as a 'held' row that blocks the room for 10 minutes while the caller pays.
-- The exclusion constraint makes double-booking impossible, even when two callers race.

create extension if not exists btree_gist;

create table if not exists public.room_types (
  id             text primary key,
  name           text not null,
  description    text not null,
  max_guests     integer not null check (max_guests > 0),
  nightly_rate   integer not null check (nightly_rate > 0), -- whole pesos (PHP)
  sort_order     integer not null default 0
);

create table if not exists public.rooms (
  id            text primary key,
  room_type_id  text not null references public.room_types (id) on delete cascade,
  label         text not null
);

create table if not exists public.bookings (
  id                 uuid primary key default gen_random_uuid(),
  code               text not null unique,
  room_id            text not null references public.rooms (id) on delete cascade,
  guest_name         text not null,
  guest_email        text,
  guests             integer not null check (guests > 0),
  check_in           date not null,
  check_out          date not null,
  status             text not null check (status in ('held', 'confirmed', 'cancelled', 'expired')),
  source             text not null check (source in ('seed', 'demo')),
  nights             integer generated always as (check_out - check_in) stored,
  total_amount       integer not null check (total_amount >= 0), -- whole pesos
  payment_option     text check (payment_option in ('full', 'deposit')),
  amount_due         integer, -- what the caller pays now, whole pesos
  amount_paid        integer not null default 0,
  hold_expires_at    timestamptz,
  stripe_session_id  text unique,
  call_room          text, -- LiveKit room the booking was made from
  created_at         timestamptz not null default now(),
  confirmed_at       timestamptz,
  constraint bookings_dates check (check_out > check_in),
  -- One active booking per room per night. Stale holds are marked 'expired' before new holds.
  constraint bookings_no_overlap exclude using gist (
    room_id with =,
    daterange(check_in, check_out, '[)') with &&
  ) where (status in ('held', 'confirmed'))
);

create index if not exists bookings_dates_idx on public.bookings (check_in, check_out);
create index if not exists bookings_status_idx on public.bookings (status);

alter table public.room_types enable row level security;
alter table public.rooms enable row level security;
alter table public.bookings enable row level security;

-- Marks holds whose 10 minutes have passed as expired, freeing their rooms.
create or replace function public.expire_stale_holds()
returns integer
language sql
as $$
  with expired as (
    update public.bookings
       set status = 'expired'
     where status = 'held' and hold_expires_at < now()
    returning 1
  )
  select count(*)::integer from expired;
$$;

-- Free rooms per room type for a stay. check_out is exclusive (the departure day).
create or replace function public.check_availability(p_check_in date, p_check_out date, p_guests integer default 1)
returns table (
  room_type_id   text,
  name           text,
  description    text,
  max_guests     integer,
  nightly_rate   integer,
  nights         integer,
  total_amount   integer,
  rooms_left     integer
)
language plpgsql
as $$
begin
  if p_check_out <= p_check_in then
    raise exception 'check_out must be after check_in';
  end if;
  perform public.expire_stale_holds();

  return query
  select t.id, t.name, t.description, t.max_guests, t.nightly_rate,
         (p_check_out - p_check_in)::integer,
         (t.nightly_rate * (p_check_out - p_check_in))::integer,
         count(r.id) filter (where not exists (
           select 1 from public.bookings b
            where b.room_id = r.id
              and b.status in ('held', 'confirmed')
              and daterange(b.check_in, b.check_out, '[)') && daterange(p_check_in, p_check_out, '[)')
         ))::integer
    from public.room_types t
    join public.rooms r on r.room_type_id = t.id
   where t.max_guests >= p_guests
   group by t.id
   order by t.sort_order;
end;
$$;

-- Holds the first free room of a type for 10 minutes. Returns the new booking.
-- Raises 'no_rooms_available' if every room of that type is taken for those dates.
create or replace function public.create_hold(
  p_room_type_id    text,
  p_check_in        date,
  p_check_out       date,
  p_guests          integer,
  p_guest_name      text,
  p_guest_email     text,
  p_payment_option  text,
  p_call_room       text default null,
  p_hold_minutes    integer default 10
)
returns public.bookings
language plpgsql
as $$
declare
  v_type    public.room_types;
  v_room    record;
  v_total   integer;
  v_booking public.bookings;
  v_code    text;
begin
  perform public.expire_stale_holds();

  select * into v_type from public.room_types where id = p_room_type_id;
  if not found then raise exception 'unknown_room_type'; end if;
  if p_guests > v_type.max_guests then raise exception 'too_many_guests'; end if;
  if p_payment_option not in ('full', 'deposit') then raise exception 'bad_payment_option'; end if;

  v_total := v_type.nightly_rate * (p_check_out - p_check_in);

  for v_room in select id from public.rooms where room_type_id = p_room_type_id order by id loop
    v_code := 'IA-' || upper(substr(md5(gen_random_uuid()::text), 1, 6));
    begin
      insert into public.bookings (
        code, room_id, guest_name, guest_email, guests, check_in, check_out, status, source,
        total_amount, payment_option, amount_due, hold_expires_at, call_room
      ) values (
        v_code, v_room.id, p_guest_name, p_guest_email, p_guests, p_check_in, p_check_out, 'held', 'demo',
        v_total, p_payment_option,
        case when p_payment_option = 'full' then v_total else ceil(v_total / 2.0)::integer end,
        now() + make_interval(mins => p_hold_minutes), p_call_room
      )
      returning * into v_booking;
      return v_booking;
    exception when exclusion_violation then
      -- That room is taken for these dates; try the next one.
    end;
  end loop;

  raise exception 'no_rooms_available';
end;
$$;

-- Marks a held booking as paid. If the hold had already expired but the room is still free,
-- the booking is confirmed anyway. Returns null if the room was taken in the meantime, so the
-- caller can refund the payment.
create or replace function public.confirm_booking(p_booking_id uuid, p_amount_paid integer)
returns public.bookings
language plpgsql
as $$
declare
  v_booking public.bookings;
begin
  begin
    update public.bookings
       set status = 'confirmed', amount_paid = p_amount_paid, confirmed_at = coalesce(confirmed_at, now())
     where id = p_booking_id and status in ('held', 'expired', 'confirmed')
    returning * into v_booking;
  exception when exclusion_violation then
    return null;
  end;
  return v_booking;
end;
$$;

grant select, insert, update, delete on public.room_types, public.rooms, public.bookings to service_role;
grant execute on function public.expire_stale_holds(), public.check_availability(date, date, integer),
  public.create_hold(text, date, date, integer, text, text, text, text, integer),
  public.confirm_booking(uuid, integer) to service_role;
revoke execute on function public.expire_stale_holds(), public.check_availability(date, date, integer),
  public.create_hold(text, date, date, integer, text, text, text, text, integer),
  public.confirm_booking(uuid, integer) from public, anon, authenticated;
