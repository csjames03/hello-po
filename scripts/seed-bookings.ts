// Generates demo bookings for this month and the next two, writes them to
// data/demo-bookings.json, and loads the room catalog and bookings into Supabase.
//
// Usage:
//   npm run seed:bookings               # regenerate from today and load into Supabase
//   npm run seed:bookings -- --json-only
//   npm run seed:bookings -- --seed 7   # a different (still reproducible) random layout
//
// Re-running replaces only seeded bookings (source = 'seed'). Bookings made in demo calls stay.
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

process.loadEnvFile(new URL('../.env', import.meta.url));

const { values } = parseArgs({
  options: {
    'json-only': { type: 'boolean', default: false },
    seed: { type: 'string', default: '42' },
  },
});

interface RoomType {
  id: string;
  name: string;
  description: string;
  maxGuests: number;
  nightlyRate: number;
  units: number;
}
interface Catalog {
  roomTypes: RoomType[];
}
interface SeedBooking {
  code: string;
  room_id: string;
  guest_name: string;
  guests: number;
  check_in: string;
  check_out: string;
  total_amount: number;
}

const catalog = JSON.parse(
  readFileSync(new URL('../data/rooms.json', import.meta.url), 'utf8'),
) as Catalog;

// Small deterministic PRNG (mulberry32), so the same seed gives the same calendar.
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = prng(Number(values.seed));
const pick = <T>(items: T[]) => items[Math.floor(rand() * items.length)]!;

const firstNames = [
  'Maria',
  'Jose',
  'Andrea',
  'Paolo',
  'Bea',
  'Miguel',
  'Camille',
  'Rafael',
  'Isabel',
  'Carlo',
  'Hannah',
  'Daniel',
  'Sofia',
  'Marco',
  'Grace',
  'Liam',
  'Yuki',
  'Emma',
  'Noah',
  'Chloe',
  'Ji-woo',
  'Lucas',
  'Aisha',
  'Ethan',
];
const lastNames = [
  'Santos',
  'Reyes',
  'Cruz',
  'Bautista',
  'Garcia',
  'Mendoza',
  'Torres',
  'Villanueva',
  'Ramos',
  'Aquino',
  'Tan',
  'Lim',
  'Smith',
  'Kim',
  'Tanaka',
  'Muller',
  'Brown',
  'Rossi',
  'Dubois',
  'Khan',
];

// Dates are plain calendar days in the resort's time zone (Asia/Manila).
const manilaToday = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
const [year, month] = manilaToday.split('-').map(Number) as [number, number];
const start = new Date(Date.UTC(year, month - 1, 1));
const end = new Date(Date.UTC(year, month + 2, 1)); // first day after the 3-month window
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

const bookings: SeedBooking[] = [];
const codes = new Set<string>();
const newCode = () => {
  let code: string;
  do {
    code =
      'IA-' +
      Math.floor(rand() * 36 ** 6)
        .toString(36)
        .toUpperCase()
        .padStart(6, '0');
  } while (codes.has(code));
  codes.add(code);
  return code;
};

for (const type of catalog.roomTypes) {
  for (let unit = 1; unit <= type.units; unit++) {
    const roomId = `${type.id}-${unit}`;
    let cursor = start;
    while (cursor < end) {
      const weekday = cursor.getUTCDay(); // 5 = Friday, 6 = Saturday
      const weekend = weekday === 5 || weekday === 6;
      // About 60% occupancy, busier on weekends and in the villas.
      const chance = (weekend ? 0.55 : 0.3) + (type.id === 'villa' ? 0.1 : 0);
      if (rand() < chance) {
        const nights = 1 + Math.floor(rand() * (weekend ? 3 : 5));
        const checkOut = addDays(cursor, nights);
        if (checkOut > end) break;
        bookings.push({
          code: newCode(),
          room_id: roomId,
          guest_name: `${pick(firstNames)} ${pick(lastNames)}`,
          guests: 1 + Math.floor(rand() * type.maxGuests),
          check_in: day(cursor),
          check_out: day(checkOut),
          total_amount: nights * type.nightlyRate,
        });
        cursor = checkOut;
      } else {
        cursor = addDays(cursor, 1);
      }
    }
  }
}

bookings.sort((a, b) => a.check_in.localeCompare(b.check_in) || a.room_id.localeCompare(b.room_id));
const file = new URL('../data/demo-bookings.json', import.meta.url);
writeFileSync(
  file,
  JSON.stringify(
    {
      generatedFor: manilaToday,
      from: day(start),
      to: day(addDays(end, -1)),
      seed: values.seed,
      bookings,
    },
    null,
    2,
  ) + '\n',
);

const roomNights =
  catalog.roomTypes.reduce((n, t) => n + t.units, 0) *
  ((end.getTime() - start.getTime()) / 86_400_000);
const booked = bookings.reduce(
  (n, b) => n + (Date.parse(b.check_out) - Date.parse(b.check_in)) / 86_400_000,
  0,
);
console.log(
  `Generated ${bookings.length} bookings from ${day(start)} to ${day(addDays(end, -1))} ` +
    `(${Math.round((booked / roomNights) * 100)}% of room-nights) -> data/demo-bookings.json`,
);

if (values['json-only']) process.exit(0);

// ---------- Load into Supabase ----------
const url = process.env.SUPABASE_URL?.replace(/\/+$/, '');
const key = process.env.SUPABASE_SECRET_KEY;
if (!url || !key)
  throw new Error('Set SUPABASE_URL and SUPABASE_SECRET_KEY in .env, or use --json-only');
const headers: Record<string, string> = { apikey: key, 'Content-Type': 'application/json' };
if (!key.startsWith('sb_secret_')) headers.Authorization = `Bearer ${key}`;

async function rest(path: string, init: RequestInit & { prefer?: string }) {
  const res = await fetch(`${url}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, ...(init.prefer ? { Prefer: init.prefer } : {}) },
  });
  if (!res.ok)
    throw new Error(`Supabase ${init.method} ${path}: ${res.status} ${await res.text()}`);
}

await rest('room_types?on_conflict=id', {
  method: 'POST',
  prefer: 'resolution=merge-duplicates',
  body: JSON.stringify(
    catalog.roomTypes.map((t, i) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      max_guests: t.maxGuests,
      nightly_rate: t.nightlyRate,
      sort_order: i,
    })),
  ),
});
await rest('rooms?on_conflict=id', {
  method: 'POST',
  prefer: 'resolution=merge-duplicates',
  body: JSON.stringify(
    catalog.roomTypes.flatMap((t) =>
      Array.from({ length: t.units }, (_, i) => ({
        id: `${t.id}-${i + 1}`,
        room_type_id: t.id,
        label: `${t.name} ${i + 1}`,
      })),
    ),
  ),
});
await rest('bookings?source=eq.seed', { method: 'DELETE' });
await rest('bookings', {
  method: 'POST',
  body: JSON.stringify(
    bookings.map((b) => ({
      ...b,
      status: 'confirmed',
      source: 'seed',
      payment_option: 'full',
      amount_due: b.total_amount,
      amount_paid: b.total_amount,
      confirmed_at: new Date().toISOString(),
    })),
  ),
});
console.log('Loaded room catalog and seeded bookings into Supabase.');
