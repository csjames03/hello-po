// The booking form Mara shows in the chat, and everything after it: the 10-minute hold,
// Stripe payment (test mode), and the confirmation. Each status change is reported to the
// agent so Mara can say it out loud.
import {
  BOOKING_RULES,
  type BookingOfferEvent,
  type BookingStatus,
  type BookingUpdateEvent,
  type PaymentOption,
  formatPeso,
} from '@hello-po/shared';
import { useEffect, useRef, useState } from 'react';

/** The booking as returned by the API (amounts in whole pesos). */
interface Hold {
  id: string;
  code: string;
  status: BookingStatus;
  roomName: string;
  checkIn: string;
  checkOut: string;
  nights: number;
  guests: number;
  guestName: string;
  paymentOption: PaymentOption;
  totalAmount: number;
  amountDue: number;
  amountPaid: number;
  holdExpiresAt: string;
  checkoutUrl?: string;
}

type Phase = 'form' | 'submitting' | BookingStatus;

const shortDate = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

const deposit = (total: number) => Math.ceil((total * BOOKING_RULES.depositPercent) / 100);

export function BookingCard({
  offer,
  active,
  callRoom,
  notifyAgent,
}: {
  offer: BookingOfferEvent;
  /** False once a newer form replaces this one. */
  active: boolean;
  callRoom?: string;
  notifyAgent: (update: BookingUpdateEvent) => void;
}) {
  const [roomTypeId, setRoomTypeId] = useState(
    offer.selectedRoomTypeId ?? offer.options[0]?.roomTypeId ?? '',
  );
  const [name, setName] = useState(offer.guestName ?? '');
  const [email, setEmail] = useState(offer.guestEmail ?? '');
  const [payment, setPayment] = useState<PaymentOption>('deposit');
  const [phase, setPhase] = useState<Phase>('form');
  const [hold, setHold] = useState<Hold | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reported = useRef(new Set<BookingStatus>());

  const option = offer.options.find((o) => o.roomTypeId === roomTypeId) ?? offer.options[0]!;
  const dueNow = payment === 'full' ? option.totalAmount : deposit(option.totalAmount);

  // Tell the agent about each status once.
  function report(status: BookingStatus, h: Hold | null, reason?: string) {
    if (reported.current.has(status)) return;
    reported.current.add(status);
    notifyAgent({
      type: 'booking_update',
      status,
      code: h?.code,
      roomName: h?.roomName ?? option.name,
      checkIn: offer.checkIn,
      checkOut: offer.checkOut,
      guestName: h?.guestName,
      paymentOption: h?.paymentOption,
      amountPaid: h?.amountPaid,
      totalAmount: h?.totalAmount,
      holdExpiresAt: h?.holdExpiresAt,
      reason,
    });
  }

  async function confirm(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setPhase('submitting');
    // Open the payment tab now, while we still have the click; browsers block it after an await.
    const payTab = window.open('', '_blank');
    try {
      const res = await fetch('/api/holds', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomTypeId,
          checkIn: offer.checkIn,
          checkOut: offer.checkOut,
          guests: offer.guests,
          guestName: name,
          guestEmail: email,
          paymentOption: payment,
          callRoom,
        }),
      });
      const body = (await res.json()) as Hold & { error?: string };
      if (!res.ok) throw new Error(body.error ?? 'Could not hold the room.');
      setHold(body);
      setPhase('held');
      report('held', body);
      if (payTab && body.checkoutUrl) payTab.location.href = body.checkoutUrl;
      else payTab?.close();
    } catch (err) {
      payTab?.close();
      const message = err instanceof Error ? err.message : 'Could not hold the room.';
      setError(message);
      setPhase('form');
      if (message.includes('just booked')) report('failed', null, message);
    }
  }

  // While held, poll the server; it checks Stripe and confirms the booking once paid.
  useEffect(() => {
    if (phase !== 'held' || !hold) return;
    const timer = setInterval(async () => {
      const res = await fetch(`/api/holds/${hold.id}`).catch(() => null);
      if (!res?.ok) return;
      const latest = (await res.json()) as Hold;
      if (latest.status === 'held') return;
      setHold((h) => ({ ...h!, ...latest }));
      setPhase(latest.status);
      report(latest.status, latest);
    }, 3000);
    return () => clearInterval(timer);
  }, [phase, hold?.id]);

  async function cancelHold() {
    if (!hold) return;
    const res = await fetch(`/api/holds/${hold.id}/cancel`, { method: 'POST' });
    const latest = (await res.json()) as Hold;
    setHold((h) => ({ ...h!, ...latest }));
    setPhase(latest.status);
    report(latest.status, latest);
  }

  const stay = `${shortDate(offer.checkIn)} → ${shortDate(offer.checkOut)} · ${plural(option.nights, 'night')} · ${plural(offer.guests, 'guest')}`;

  return (
    <article className="overflow-hidden rounded-xl border border-cyan-900/60 bg-slate-900 shadow-lg shadow-cyan-950/30">
      <header className="flex items-center justify-between gap-3 bg-gradient-to-r from-cyan-800 to-teal-700 px-4 py-3">
        <div>
          <p className="text-[11px] font-medium tracking-wider text-cyan-100/80 uppercase">
            Isla Azul Beach Resort
          </p>
          <h3 className="font-semibold text-white">
            {phase === 'confirmed' ? 'Booking confirmed' : 'Book your stay'}
          </h3>
        </div>
        <StatusPill phase={phase} />
      </header>

      <div className="space-y-4 p-4">
        <p className="text-sm text-slate-300">{stay}</p>

        {(phase === 'form' || phase === 'submitting') && (
          <form onSubmit={confirm} className="space-y-4">
            <fieldset disabled={!active || phase === 'submitting'} className="space-y-4">
              <legend className="sr-only">Room type</legend>
              <div className="grid gap-2">
                {offer.options.map((o) => (
                  <label
                    key={o.roomTypeId}
                    className={`flex cursor-pointer items-start gap-3 rounded-lg border p-3 transition ${
                      o.roomTypeId === roomTypeId
                        ? 'border-cyan-500 bg-cyan-950/40'
                        : 'border-slate-700 hover:border-slate-500'
                    }`}
                  >
                    <input
                      type="radio"
                      name={`room-${offer.offerId}`}
                      value={o.roomTypeId}
                      checked={o.roomTypeId === roomTypeId}
                      onChange={() => setRoomTypeId(o.roomTypeId)}
                      className="mt-1 accent-cyan-500"
                    />
                    <span className="flex-1">
                      <span className="flex flex-wrap items-baseline justify-between gap-x-2">
                        <span className="font-medium text-slate-100">{o.name}</span>
                        <span className="text-sm text-slate-300">
                          {formatPeso(o.nightlyRate)}
                          <span className="text-slate-500"> / night</span>
                        </span>
                      </span>
                      <span className="mt-0.5 block text-xs text-slate-400">{o.description}</span>
                      <span className="mt-1 flex flex-wrap gap-2 text-xs">
                        <span className="text-slate-300">Total {formatPeso(o.totalAmount)}</span>
                        <span className="text-slate-500">· up to {o.maxGuests} guests</span>
                        {o.roomsLeft <= 2 && (
                          <span className="rounded bg-amber-900/60 px-1.5 text-amber-200">
                            Only {o.roomsLeft} left
                          </span>
                        )}
                      </span>
                    </span>
                  </label>
                ))}
              </div>

              <div className="grid gap-3 sm:grid-cols-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-400">Full name</span>
                  <input
                    required
                    minLength={2}
                    autoComplete="name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-500"
                  />
                </label>
                <label className="block text-sm">
                  <span className="mb-1 block text-slate-400">Email for the confirmation</span>
                  <input
                    required
                    type="email"
                    autoComplete="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-slate-100 outline-none focus:border-cyan-500"
                  />
                </label>
              </div>

              <div role="radiogroup" aria-label="Payment" className="grid gap-2 sm:grid-cols-2">
                {(['deposit', 'full'] as const).map((p) => {
                  const amount = p === 'full' ? option.totalAmount : deposit(option.totalAmount);
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={payment === p}
                      onClick={() => setPayment(p)}
                      className={`rounded-lg border p-3 text-left transition ${
                        payment === p
                          ? 'border-cyan-500 bg-cyan-950/40'
                          : 'border-slate-700 hover:border-slate-500'
                      }`}
                    >
                      <span className="block text-sm font-medium text-slate-100">
                        {p === 'full' ? 'Pay in full' : `${BOOKING_RULES.depositPercent}% deposit`}
                      </span>
                      <span className="block text-xs text-slate-400">
                        {formatPeso(amount)} now
                        {p === 'deposit' &&
                          `, ${formatPeso(option.totalAmount - amount)} at check-in`}
                      </span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            {error && <p className="rounded bg-rose-950 p-2 text-sm text-rose-200">{error}</p>}

            {active ? (
              <div className="space-y-2">
                <button
                  type="submit"
                  disabled={phase === 'submitting'}
                  className="w-full rounded-lg bg-cyan-600 px-4 py-2.5 font-medium text-white transition hover:bg-cyan-500 disabled:opacity-60"
                >
                  {phase === 'submitting'
                    ? 'Holding your room…'
                    : `Confirm and pay ${formatPeso(dueNow)}`}
                </button>
                <p className="text-center text-xs text-slate-500">
                  We hold the room for {BOOKING_RULES.holdMinutes} minutes while you pay. Stripe
                  test mode: no real charge.
                </p>
              </div>
            ) : (
              <p className="text-center text-xs text-slate-500">Replaced by a newer form.</p>
            )}
          </form>
        )}

        {hold && phase === 'held' && <HeldPanel hold={hold} onCancel={cancelHold} />}

        {hold && phase === 'confirmed' && (
          <div className="space-y-3">
            <div className="rounded-lg border border-emerald-800 bg-emerald-950/40 p-4 text-center">
              <p className="text-xs tracking-wider text-emerald-300/80 uppercase">Booking code</p>
              <p className="mt-1 font-mono text-2xl font-semibold tracking-widest text-emerald-200">
                {hold.code}
              </p>
            </div>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
              <dt className="text-slate-400">Room</dt>
              <dd className="text-right text-slate-100">{hold.roomName}</dd>
              <dt className="text-slate-400">Guest</dt>
              <dd className="text-right text-slate-100">{hold.guestName}</dd>
              <dt className="text-slate-400">Paid</dt>
              <dd className="text-right text-slate-100">{formatPeso(hold.amountPaid)}</dd>
              <dt className="text-slate-400">Due at check-in</dt>
              <dd className="text-right text-slate-100">
                {formatPeso(hold.totalAmount - hold.amountPaid)}
              </dd>
            </dl>
            <p className="text-center text-xs text-slate-500">
              A confirmation email is on its way to {email}.
            </p>
          </div>
        )}

        {(phase === 'expired' || phase === 'cancelled' || phase === 'failed') && (
          <p className="rounded-lg border border-slate-700 bg-slate-950 p-3 text-sm text-slate-300">
            {phase === 'expired'
              ? 'The 10-minute hold ran out, so the room was released. Ask Mara to check again.'
              : phase === 'cancelled'
                ? 'Hold cancelled. The room has been released.'
                : 'This booking could not be completed. Ask Mara for other options.'}
          </p>
        )}
      </div>
    </article>
  );
}

function StatusPill({ phase }: { phase: Phase }) {
  const styles: Record<Phase, [string, string]> = {
    form: ['Select options', 'bg-white/15 text-white'],
    submitting: ['Holding…', 'bg-white/15 text-white'],
    held: ['Held', 'bg-amber-400 text-amber-950'],
    confirmed: ['Confirmed', 'bg-emerald-400 text-emerald-950'],
    expired: ['Expired', 'bg-slate-300 text-slate-900'],
    cancelled: ['Cancelled', 'bg-slate-300 text-slate-900'],
    failed: ['Unavailable', 'bg-rose-300 text-rose-950'],
  };
  const [label, cls] = styles[phase];
  return <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${cls}`}>{label}</span>;
}

function HeldPanel({ hold, onCancel }: { hold: Hold; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const total = BOOKING_RULES.holdMinutes * 60_000;
  const left = Math.max(0, Date.parse(hold.holdExpiresAt) - now);
  const mm = Math.floor(left / 60_000);
  const ss = Math.floor((left % 60_000) / 1000)
    .toString()
    .padStart(2, '0');
  const urgent = left < 120_000;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-4 rounded-lg border border-amber-800/70 bg-amber-950/30 p-3">
        <div
          className={`font-mono text-2xl font-semibold tabular-nums ${urgent ? 'text-rose-300' : 'text-amber-200'}`}
          aria-live="polite"
        >
          {mm}:{ss}
        </div>
        <div className="flex-1">
          <p className="text-sm text-amber-100">
            {hold.roomName} held for you · <span className="font-mono">{hold.code}</span>
          </p>
          <div className="mt-2 h-1.5 overflow-hidden rounded bg-amber-950">
            <div
              className={`h-full transition-[width] duration-1000 ${urgent ? 'bg-rose-400' : 'bg-amber-400'}`}
              style={{ width: `${(left / total) * 100}%` }}
            />
          </div>
        </div>
      </div>

      {hold.checkoutUrl && (
        <a
          href={hold.checkoutUrl}
          target="_blank"
          rel="noreferrer"
          className="block w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-center font-medium text-white transition hover:bg-indigo-500"
        >
          Pay {formatPeso(hold.amountDue)} with Stripe
        </a>
      )}
      <p className="text-center text-xs text-slate-500">
        Test card <span className="font-mono text-slate-300">4242 4242 4242 4242</span>, any future
        date, any CVC. Waiting for payment…
      </p>
      <button
        type="button"
        onClick={onCancel}
        className="w-full text-center text-xs text-slate-400 underline-offset-2 hover:text-slate-200 hover:underline"
      >
        Cancel hold
      </button>
    </div>
  );
}
