// Booking tools the LLM can call: check availability, show the booking form in the chat, and
// look up an existing booking. The hold, payment, and email happen in the server, after the
// caller confirms the form, so the agent never takes an action the caller didn't approve.
import {
  BOOKING_RULES,
  type BookingOfferEvent,
  type BookingOption,
  type BookingUpdateEvent,
} from '@hello-po/shared';
import { llm } from '@livekit/agents';
import type { Room } from '@livekit/rtc-node';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rpc, select } from './db.ts';
import { publishEvent } from './events.ts';

/** Today's date at the resort (Asia/Manila), as YYYY-MM-DD. */
export const resortToday = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .describe('Calendar date as YYYY-MM-DD');

const stay = {
  checkIn: isoDate.describe('Arrival date, YYYY-MM-DD'),
  checkOut: isoDate.describe('Departure date, YYYY-MM-DD (the morning they leave)'),
  guests: z.number().int().min(1).max(10).describe('Number of guests'),
};

const pesos = (n: number) => `${n.toLocaleString('en-PH')} pesos`;
const nightsBetween = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

/** Returns an error message the model can say, or null if the stay is valid. */
function checkStay(checkIn: string, checkOut: string): string | null {
  if (Number.isNaN(Date.parse(checkIn)) || Number.isNaN(Date.parse(checkOut))) {
    return 'Those dates are not valid. Ask the caller to repeat them.';
  }
  if (checkIn < resortToday()) return 'The arrival date is in the past. Ask for a future date.';
  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) return 'The departure date must be after the arrival date.';
  if (nights > BOOKING_RULES.maxNights) {
    return `Stays are limited to ${BOOKING_RULES.maxNights} nights in this demo.`;
  }
  return null;
}

interface AvailabilityRow {
  room_type_id: string;
  name: string;
  description: string;
  max_guests: number;
  nightly_rate: number;
  nights: number;
  total_amount: number;
  rooms_left: number;
}

async function availability(checkIn: string, checkOut: string, guests: number) {
  const rows = await rpc<AvailabilityRow[]>('check_availability', {
    p_check_in: checkIn,
    p_check_out: checkOut,
    p_guests: guests,
  });
  return rows.map((r): BookingOption => ({
    roomTypeId: r.room_type_id,
    name: r.name,
    description: r.description,
    maxGuests: r.max_guests,
    nightlyRate: r.nightly_rate,
    nights: r.nights,
    totalAmount: r.total_amount,
    roomsLeft: r.rooms_left,
  }));
}

/** Normalises a spoken booking code ("I A dash nine three Y O K two") to "IA-93YOK2". */
function normaliseCode(spoken: string): string {
  const chars = spoken.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return `IA-${chars.startsWith('IA') ? chars.slice(2) : chars}`;
}

interface BookingRow {
  code: string;
  guest_name: string;
  guests: number;
  check_in: string;
  check_out: string;
  status: string;
  payment_option: string | null;
  amount_paid: number;
  total_amount: number;
  rooms: { room_types: { name: string } };
}

const bookingColumns =
  'code,guest_name,guests,check_in,check_out,status,payment_option,amount_paid,total_amount,' +
  'rooms(room_types(name))';

export async function findBooking(code: string): Promise<BookingRow | undefined> {
  const rows = await select<BookingRow>(
    `bookings?code=eq.${encodeURIComponent(code)}&select=${bookingColumns}`,
  );
  return rows[0];
}

/** Number of single-character edits between two strings (Levenshtein distance). */
function editDistance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const substitute = prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1);
      row[j] = Math.min(prev[j]! + 1, row[j - 1]! + 1, substitute);
    }
    prev = row;
  }
  return prev[b.length]!;
}

/**
 * Finds a booking from a spoken code and last name. Speech-to-text often mishears one
 * character of a spelled code ("Y O K" as "Y Q K"), so if there is no exact match, this
 * accepts a code one character off, but only when the last name matches and exactly one of
 * that guest's bookings is that close.
 */
async function findSpokenBooking(code: string, lastName: string) {
  const name = lastName.trim().toLowerCase();
  const matchesName = (b: BookingRow) => b.guest_name.toLowerCase().includes(name);
  const exact = await findBooking(code);
  if (exact) return matchesName(exact) ? exact : undefined;
  if (name.length < 2) return undefined;

  const pattern = encodeURIComponent(`*${name.replace(/[*,()]/g, '')}*`);
  const sameName = await select<BookingRow>(
    `bookings?guest_name=ilike.${pattern}&select=${bookingColumns}&limit=100`,
  );
  const close = sameName.filter((b) => matchesName(b) && editDistance(b.code, code) <= 1);
  return close.length === 1 ? close[0] : undefined;
}

/**
 * Runs a tool step with filler speech if it takes a while, and logs how long it took.
 * The prompt also asks Mara to say a few words before calling a tool, so the caller rarely
 * waits in silence; the filler only fires after a stretch of silence.
 */
async function timed<T>(name: string, opts: llm.ToolOptions, fn: () => Promise<T>): Promise<T> {
  const started = performance.now();
  try {
    return await opts.ctx.filler('One moment, let me check that.', { delay: 900 }, fn);
  } finally {
    console.log(`[tool] ${name} ${Math.round(performance.now() - started)}ms`);
  }
}

export function createBookingTools(room: Room) {
  return {
    checkAvailability: llm.tool({
      description:
        'Check which room types are free for a stay, with prices. Call this before quoting ' +
        'availability or prices, and again whenever the dates or number of guests change.',
      parameters: z.object(stay),
      execute: ({ checkIn, checkOut, guests }, opts) =>
        timed('checkAvailability', opts, async () => {
          const invalid = checkStay(checkIn, checkOut);
          if (invalid) return invalid;
          const options = await availability(checkIn, checkOut, guests);
          const free = options.filter((o) => o.roomsLeft > 0);
          if (free.length === 0) {
            return `Nothing is free from ${checkIn} to ${checkOut} for ${guests} guests. Offer to check other dates.`;
          }
          const nights = free[0]!.nights;
          const lines = free.map(
            (o) =>
              `${o.name}: ${pesos(o.nightlyRate)} a night, ${pesos(o.totalAmount)} total, ` +
              `${o.roomsLeft} left, up to ${o.maxGuests} guests`,
          );
          const full = options.filter((o) => o.roomsLeft === 0).map((o) => o.name);
          return (
            `${nights} night${nights === 1 ? '' : 's'}, ${checkIn} to ${checkOut}, ${guests} guests. ` +
            `Available: ${lines.join('; ')}.` +
            (full.length ? ` Fully booked: ${full.join(', ')}.` : '')
          );
        }),
    }),

    showBookingForm: llm.tool({
      description:
        'Show the booking form on the caller’s screen once they want to book. It is prefilled ' +
        'with the stay and lets them pick the room, enter their name and email, and choose to ' +
        'pay in full or a 50% deposit. Only call this after checkAvailability found rooms.',
      parameters: z.object({
        ...stay,
        roomTypeId: z
          .string()
          .optional()
          .describe('Room type id the caller chose, e.g. "garden", "ocean", "family", "villa"'),
        guestName: z.string().optional().describe('Caller name, if they gave it'),
      }),
      execute: ({ checkIn, checkOut, guests, roomTypeId, guestName }, opts) =>
        timed('showBookingForm', opts, async () => {
          const invalid = checkStay(checkIn, checkOut);
          if (invalid) return invalid;
          const options = (await availability(checkIn, checkOut, guests)).filter(
            (o) => o.roomsLeft > 0,
          );
          if (options.length === 0) return 'Those dates just sold out. Offer other dates.';

          const event: BookingOfferEvent = {
            type: 'booking_offer',
            offerId: randomUUID(),
            checkIn,
            checkOut,
            guests,
            options,
            selectedRoomTypeId: options.some((o) => o.roomTypeId === roomTypeId)
              ? roomTypeId
              : undefined,
            guestName,
          };
          await publishEvent(room, event);
          return (
            'The booking form is now on the caller’s screen. Tell them to check the details, ' +
            'choose full payment or a 50% deposit, and press Confirm. Confirming holds the room ' +
            `for ${BOOKING_RULES.holdMinutes} minutes while they pay. Do not say it is booked yet.`
          );
        }),
    }),

    lookupBooking: llm.tool({
      description:
        'Look up an existing booking by its booking code and the guest’s last name. Ask for ' +
        'both before calling. Booking codes look like "IA-93YOK2".',
      parameters: z.object({
        code: z.string().describe('Booking code as spoken, e.g. "IA-93YOK2"'),
        lastName: z.string().describe('Guest last name, to verify the booking belongs to them'),
      }),
      execute: ({ code, lastName }, opts) =>
        timed('lookupBooking', opts, async () => {
          const booking = await findSpokenBooking(normaliseCode(code), lastName);
          // Same answer for "no such code" and "wrong name", so codes can't be probed.
          if (!booking) {
            return 'No booking matches that code and last name. Ask them to check both.';
          }
          const balance = booking.total_amount - booking.amount_paid;
          return (
            `Booking ${booking.code} for ${booking.guest_name}: ${booking.rooms.room_types.name}, ` +
            `${booking.check_in} to ${booking.check_out}, ${booking.guests} guests, status ` +
            `${booking.status}. Paid ${pesos(booking.amount_paid)} of ${pesos(booking.total_amount)}` +
            (balance > 0 ? `, ${pesos(balance)} due at check-in.` : ', fully paid.')
          );
        }),
    }),
  };
}

/**
 * Turns a booking update from the browser into an instruction for the agent's next reply.
 * A "confirmed" update is checked against the database first, because the browser could send
 * anything.
 */
export async function describeBookingUpdate(update: BookingUpdateEvent): Promise<string | null> {
  switch (update.status) {
    case 'held':
      return (
        `The caller confirmed the form. A ${update.roomName ?? 'room'} is held for ` +
        `${BOOKING_RULES.holdMinutes} minutes. Briefly tell them to finish paying on the Stripe ` +
        'page that opened, and that the booking is confirmed once payment goes through.'
      );
    case 'confirmed': {
      if (!update.code) return null;
      const booking = await findBooking(update.code);
      if (booking?.status !== 'confirmed') return null;
      const balance = booking.total_amount - booking.amount_paid;
      return (
        `Payment went through. Booking ${booking.code} is confirmed: ` +
        `${booking.rooms.room_types.name}, ${booking.check_in} to ${booking.check_out}. They paid ` +
        `${pesos(booking.amount_paid)}` +
        (balance > 0 ? ` and ${pesos(balance)} is due at check-in` : ', the full amount') +
        '. A confirmation email is on its way. Congratulate them warmly in one or two ' +
        'sentences, spell out the booking code, and ask if there is anything else.'
      );
    }
    case 'expired':
      return (
        'The 10-minute hold ran out before payment, so the room was released. Tell them ' +
        'kindly and offer to check availability again.'
      );
    case 'cancelled':
      return 'The caller closed the booking form. Ask if they would like to change anything.';
    case 'failed':
      return (
        `The booking could not be completed (${update.reason ?? 'unknown reason'}). ` +
        'Apologise briefly and offer to check other rooms or dates.'
      );
  }
}
