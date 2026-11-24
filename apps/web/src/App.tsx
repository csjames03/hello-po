import {
  EVENTS_TOPIC,
  type BookingOfferEvent,
  type BookingUpdateEvent,
  type HelloPoEvent,
} from '@hello-po/shared';
import {
  RoomAudioRenderer,
  SessionProvider,
  useAgent,
  useDataChannel,
  useRoomContext,
  useSession,
  useSessionContext,
  useSessionMessages,
} from '@livekit/components-react';
import { TokenSource } from 'livekit-client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { BookingCard } from './BookingCard.tsx';
import { LatencyPanel } from './LatencyPanel.tsx';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// Module-level so the hook gets a stable token source.
const tokenSource = TokenSource.endpoint('/api/token');

export function App() {
  // Allow a slow agent start (cold process, busy machine) before giving up.
  const session = useSession(tokenSource, { agentConnectTimeoutMilliseconds: 30_000 });
  return (
    <SessionProvider session={session}>
      <CallScreen />
    </SessionProvider>
  );
}

function CallScreen() {
  const session = useSessionContext();
  const agent = useAgent();
  const { messages } = useSessionMessages();
  const room = useRoomContext();
  // Each card is placed after the transcript lines that existed when it arrived. Sorting by
  // timestamp misplaced it, because transcript times come from the agent's clock.
  const [offers, setOffers] = useState<{ after: number; offer: BookingOfferEvent }[]>([]);
  const transcriptCount = useRef(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  const inCall = session.isConnected;

  // Booking forms arrive from the agent; status updates go back to it on the same topic.
  const { send } = useDataChannel(EVENTS_TOPIC, (msg) => {
    const event = JSON.parse(decoder.decode(msg.payload)) as HelloPoEvent;
    if (event.type === 'booking_offer')
      setOffers((prev) => [...prev, { after: transcriptCount.current, offer: event }]);
  });
  const notifyAgent = useCallback(
    (update: BookingUpdateEvent) =>
      void send(encoder.encode(JSON.stringify(update)), { reliable: true, topic: EVENTS_TOPIC }),
    [send],
  );

  // A new call starts with an empty chat.
  useEffect(() => {
    if (!inCall) setOffers([]);
  }, [inCall]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, offers]);

  async function toggleCall() {
    setBusy(true);
    setError(null);
    try {
      if (inCall) await session.end();
      else await session.start({ tracks: { microphone: { enabled: true } } });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  const transcript = messages.filter(
    (m) => m.type === 'userTranscript' || m.type === 'agentTranscript',
  );
  transcriptCount.current = transcript.length;
  // Transcript lines with each booking card after the line it followed.
  const chat = [
    ...offers.filter((o) => o.after === 0).map((o) => ({ message: undefined, booking: o.offer })),
    ...transcript.flatMap((m, i) => [
      { message: m, booking: undefined },
      ...offers
        .filter((o) => o.after === i + 1)
        .map((o) => ({ message: undefined, booking: o.offer })),
    ]),
    // A card can arrive before the transcript catches up; keep it at the end until then.
    ...offers
      .filter((o) => o.after > transcript.length)
      .map((o) => ({ message: undefined, booking: o.offer })),
  ];
  const latestOfferId = offers.at(-1)?.offer.offerId;

  return (
    <main className="mx-auto flex min-h-screen max-w-2xl flex-col gap-6 px-4 py-10">
      <header>
        <h1 className="text-2xl font-semibold">Hello Po</h1>
        <p className="text-slate-400">Isla Azul Beach Resort · voice support line</p>
      </header>

      <section className="flex items-center gap-4">
        <button
          onClick={toggleCall}
          disabled={busy}
          className={`rounded-full px-6 py-3 font-medium disabled:opacity-50 ${
            inCall ? 'bg-rose-600 hover:bg-rose-500' : 'bg-emerald-600 hover:bg-emerald-500'
          }`}
        >
          {busy ? 'Please wait…' : inCall ? 'Hang up' : 'Call support'}
        </button>
        <span className="text-sm text-slate-400">
          {!inCall
            ? 'Not in a call'
            : agent.state === 'failed'
              ? 'Agent could not join. Hang up and try again.'
              : `Agent: ${agent.state}`}
        </span>
      </section>

      {error && <p className="rounded bg-rose-950 p-3 text-sm text-rose-200">{error}</p>}

      <section className="flex-1 space-y-3 rounded-lg border border-slate-800 p-4">
        {transcript.length === 0 && (
          <p className="text-sm text-slate-500">The transcript will appear here during a call.</p>
        )}
        {chat.map(({ message: m, booking }) =>
          booking ? (
            <BookingCard
              key={booking.offerId}
              offer={booking}
              active={booking.offerId === latestOfferId}
              callRoom={room.name}
              notifyAgent={notifyAgent}
            />
          ) : m ? (
            <div key={m.id} className={m.type === 'userTranscript' ? 'text-right' : ''}>
              <span className="block text-xs text-slate-500">
                {m.type === 'userTranscript' ? 'You' : 'Mara (agent)'}
              </span>
              <span
                className={`inline-block rounded-lg px-3 py-2 ${
                  m.type === 'userTranscript' ? 'bg-sky-900' : 'bg-slate-800'
                }`}
              >
                {m.message}
              </span>
            </div>
          ) : null,
        )}
        <div ref={bottomRef} />
      </section>

      {inCall && <LatencyPanel />}

      <RoomAudioRenderer />
    </main>
  );
}
