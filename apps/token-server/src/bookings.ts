// Booking API: hold a room for 10 minutes, take payment with Stripe Checkout (test mode),
// confirm the booking, and send the confirmation email.
//
// Payment is confirmed two ways, whichever comes first:
//   1. Stripe's webhook (checkout.session.completed), if STRIPE_WEBHOOK_SECRET is set.
//   2. The browser polling GET /api/holds/:id, which asks Stripe for the session status.
// So the demo works locally without exposing a webhook URL; `stripe listen` adds the webhook.
//
// Stripe requires a Checkout Session to stay open for at least 30 minutes, so the 10-minute hold
// is enforced here: a sweeper expires the Stripe session as soon as the hold lapses, and a
// payment that still slips through for a room that was taken in the meantime is refunded.
import { BOOKING_RULES, type BookingStatus, type PaymentOption } from '@hello-po/shared';
import express, { type Router } from 'express';
import Stripe from 'stripe';
import { z } from 'zod';
import { sendConfirmation } from './email.ts';
import { SupabaseError, rpc, select, update } from './supabase.ts';

const stripeKey = process.env.STRIPE_SECRET_KEY;
const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
const webUrl = (process.env.WEB_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
const stripe = stripeKey ? new Stripe(stripeKey) : undefined;

export const paymentsEnabled = Boolean(stripe);
export const webhookEnabled = Boolean(stripe && webhookSecret);

/** A booking row joined with its room type name. Amounts are whole pesos. */
export interface BookingRecord {
  id: string;
  code: string;
  room_id: string;
  room_type_name: string;
  guest_name: string;
  guest_email: string | null;
  guests: number;
  check_in: string;
  check_out: string;
  nights: number;
  status: BookingStatus;
  total_amount: number;
  payment_option: PaymentOption | null;
  amount_due: number | null;
  amount_paid: number;
  hold_expires_at: string | null;
  stripe_session_id: string | null;
}

type BookingRow = Omit<BookingRecord, 'room_type_name'> & {
  rooms: { room_types: { name: string } };
};

const columns =
  'id,code,room_id,guest_name,guest_email,guests,check_in,check_out,nights,status,' +
  'total_amount,payment_option,amount_due,amount_paid,hold_expires_at,stripe_session_id,' +
  'rooms(room_types(name))';

const flatten = ({ rooms, ...b }: BookingRow): BookingRecord => ({
  ...b,
  room_type_name: rooms.room_types.name,
});

async function getBooking(id: string): Promise<BookingRecord | undefined> {
  const rows = await select<BookingRow>(`bookings?id=eq.${id}&select=${columns}`);
  return rows[0] && flatten(rows[0]);
}

/** What the browser sees. Never includes the email address or Stripe ids. */
function publicView(b: BookingRecord) {
  return {
    id: b.id,
    code: b.code,
    status: b.status,
    roomName: b.room_type_name,
    checkIn: b.check_in,
    checkOut: b.check_out,
    nights: b.nights,
    guests: b.guests,
    guestName: b.guest_name,
    paymentOption: b.payment_option,
    totalAmount: b.total_amount,
    amountDue: b.amount_due,
    amountPaid: b.amount_paid,
    holdExpiresAt: b.hold_expires_at,
  };
}

// ---------- Confirming a payment ----------

// One confirmation per booking at a time, so the webhook and a poll can't both send the email.
const finalizing = new Map<string, Promise<BookingRecord | undefined>>();

async function finalizePaid(bookingId: string, session: Stripe.Checkout.Session) {
  const existing = finalizing.get(bookingId);
  if (existing) return existing;
  const task = (async () => {
    const booking = await getBooking(bookingId);
    if (!booking || booking.status === 'confirmed') return booking;

    const amountPaid = Math.round((session.amount_total ?? 0) / 100);
    const confirmed = await rpc<{ id: string | null } | null>('confirm_booking', {
      p_booking_id: bookingId,
      p_amount_paid: amountPaid,
    });
    // A plpgsql function returning a row type gives an all-null row when nothing matched.
    if (!confirmed?.id) {
      // The hold lapsed and someone else took the room. Give the money back.
      console.warn(`[booking] ${booking.code} paid after the room was taken; refunding`);
      if (typeof session.payment_intent === 'string') {
        await stripe!.refunds.create({ payment_intent: session.payment_intent });
      }
      await update(`bookings?id=eq.${bookingId}`, { status: 'cancelled' });
      return getBooking(bookingId);
    }
    const record = await getBooking(bookingId);
    console.log(`[booking] ${booking.code} confirmed, paid ${amountPaid}`);
    if (record) void sendConfirmation(record).catch((err) => console.warn('[email]', err));
    return record;
  })();
  finalizing.set(bookingId, task);
  try {
    return await task;
  } finally {
    // Keep the entry briefly so a burst of polls reuses the result.
    setTimeout(() => finalizing.delete(bookingId), 60_000);
  }
}

/** If the booking is held and Stripe says it was paid, confirm it now. */
async function syncWithStripe(booking: BookingRecord): Promise<BookingRecord> {
  if (!stripe || !booking.stripe_session_id) return booking;
  if (booking.status !== 'held' && booking.status !== 'expired') return booking;
  const session = await stripe.checkout.sessions.retrieve(booking.stripe_session_id);
  if (session.payment_status === 'paid') {
    return (await finalizePaid(booking.id, session)) ?? booking;
  }
  return booking;
}

// ---------- Releasing lapsed holds ----------

const released = new Set<string>();

/** Expires the Stripe session of every lapsed hold, then marks the holds expired. */
async function releaseLapsedHolds() {
  const now = new Date().toISOString();
  const lapsed = await select<BookingRow>(
    `bookings?status=in.(held,expired)&source=eq.demo&hold_expires_at=lt.${now}` +
      `&stripe_session_id=not.is.null&select=${columns}&limit=50`,
  );
  for (const row of lapsed.map(flatten)) {
    if (released.has(row.id) || !stripe || !row.stripe_session_id) continue;
    const session = await stripe.checkout.sessions.retrieve(row.stripe_session_id);
    if (session.payment_status === 'paid') {
      await finalizePaid(row.id, session);
    } else if (session.status === 'open') {
      await stripe.checkout.sessions.expire(row.stripe_session_id);
      console.log(`[booking] ${row.code} hold expired; payment link closed`);
    }
    released.add(row.id);
  }
  await rpc('expire_stale_holds', {});
}

export function startHoldSweeper(intervalMs = 30_000) {
  const tick = () =>
    releaseLapsedHolds().catch((err) => console.warn('[booking] sweeper failed:', err));
  setInterval(tick, intervalMs).unref();
  void tick();
}

// ---------- Routes ----------

const holdRequest = z.object({
  roomTypeId: z.string().min(1).max(40),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  guests: z.number().int().min(1).max(10),
  guestName: z.string().trim().min(2).max(80),
  guestEmail: z.email().max(120),
  paymentOption: z.enum(['full', 'deposit']),
  callRoom: z.string().max(60).optional(),
});

const holdErrors: Record<string, [number, string]> = {
  no_rooms_available: [409, 'That room type was just booked for those dates.'],
  too_many_guests: [400, 'Too many guests for that room type.'],
  unknown_room_type: [400, 'Unknown room type.'],
};

export function bookingRoutes(): Router {
  const router = express.Router();

  router.post('/holds', express.json(), async (req, res) => {
    if (!stripe) return res.status(503).json({ error: 'Payments are not configured.' });
    const parsed = holdRequest.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Please check the form details.' });
    const h = parsed.data;
    const nights = (Date.parse(h.checkOut) - Date.parse(h.checkIn)) / 86_400_000;
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Manila' });
    if (h.checkIn < today || nights < 1 || nights > BOOKING_RULES.maxNights) {
      return res.status(400).json({ error: 'Those dates are not bookable.' });
    }

    let booking: BookingRecord | undefined;
    try {
      const held = await rpc<{ id: string }>('create_hold', {
        p_room_type_id: h.roomTypeId,
        p_check_in: h.checkIn,
        p_check_out: h.checkOut,
        p_guests: h.guests,
        p_guest_name: h.guestName,
        p_guest_email: h.guestEmail,
        p_payment_option: h.paymentOption,
        p_call_room: h.callRoom ?? null,
        p_hold_minutes: BOOKING_RULES.holdMinutes,
      });
      booking = await getBooking(held.id);
    } catch (err) {
      const known = err instanceof SupabaseError && holdErrors[err.message];
      if (known) return res.status(known[0]).json({ error: known[1] });
      throw err;
    }
    if (!booking) throw new Error('hold created but not found');

    try {
      const deposit = booking.payment_option === 'deposit';
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: booking.guest_email ?? undefined,
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'php',
              unit_amount: booking.amount_due! * 100, // centavos
              product_data: {
                name: `${booking.room_type_name}, ${booking.nights} night${booking.nights === 1 ? '' : 's'}${deposit ? ' (50% deposit)' : ''}`,
                description: `${booking.check_in} to ${booking.check_out}, ${booking.guests} guest${booking.guests === 1 ? '' : 's'}. Booking ${booking.code}. Demo only, use a Stripe test card.`,
              },
            },
          },
        ],
        metadata: { booking_id: booking.id, code: booking.code },
        payment_intent_data: { metadata: { booking_id: booking.id, code: booking.code } },
        // Stripe's minimum lifetime. The sweeper closes it when the 10-minute hold lapses.
        expires_at: Math.floor(Date.now() / 1000) + 31 * 60,
        success_url: `${webUrl}/payment-complete.html?booking=${booking.code}`,
        cancel_url: `${webUrl}/payment-cancelled.html?booking=${booking.code}`,
      });
      await update(`bookings?id=eq.${booking.id}`, { stripe_session_id: session.id });
      console.log(`[booking] ${booking.code} held until ${booking.hold_expires_at}`);
      res.status(201).json({ ...publicView(booking), checkoutUrl: session.url });
    } catch (err) {
      // No payment link means no hold: release the room straight away.
      await update(`bookings?id=eq.${booking.id}`, { status: 'cancelled' });
      throw err;
    }
  });

  router.get('/holds/:id', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.status(404).end();
    const booking = await getBooking(req.params.id);
    if (!booking) return res.status(404).end();
    let current = await syncWithStripe(booking);
    // Report a lapsed hold as expired even before the sweeper runs.
    if (
      current.status === 'held' &&
      current.hold_expires_at &&
      Date.parse(current.hold_expires_at) < Date.now()
    ) {
      current = { ...current, status: 'expired' };
    }
    res.json(publicView(current));
  });

  router.post('/holds/:id/cancel', async (req, res) => {
    if (!z.uuid().safeParse(req.params.id).success) return res.status(404).end();
    const booking = await getBooking(req.params.id);
    if (!booking) return res.status(404).end();
    const synced = await syncWithStripe(booking);
    if (synced.status !== 'held') return res.json(publicView(synced));
    if (stripe && synced.stripe_session_id) {
      await stripe.checkout.sessions.expire(synced.stripe_session_id).catch(() => undefined);
    }
    await update(`bookings?id=eq.${synced.id}&status=eq.held`, { status: 'cancelled' });
    console.log(`[booking] ${synced.code} cancelled by the caller`);
    res.json(publicView({ ...synced, status: 'cancelled' }));
  });

  return router;
}

/** Stripe webhook. Must be mounted before any JSON body parser, because it needs the raw body. */
export function stripeWebhook(): Router {
  const router = express.Router();
  router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !webhookSecret) return res.status(503).end();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        req.body as Buffer,
        req.header('stripe-signature') ?? '',
        webhookSecret,
      );
    } catch {
      return res.status(400).send('Invalid signature');
    }
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const bookingId = session.metadata?.booking_id;
      if (bookingId && session.payment_status === 'paid') await finalizePaid(bookingId, session);
    }
    res.json({ received: true });
  });
  return router;
}
