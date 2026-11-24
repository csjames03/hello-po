// Hello Po API: mints LiveKit tokens (dispatching the agent into each call) and runs the
// booking flow (holds, Stripe payments, confirmation emails).
import './env.ts';
import { AGENT_NAME } from '@hello-po/shared';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import {
  bookingRoutes,
  paymentsEnabled,
  startHoldSweeper,
  stripeWebhook,
  webhookEnabled,
} from './bookings.ts';
import { emailEnabled } from './email.ts';
import { supabaseEnabled } from './supabase.ts';

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env');
}

const app = express();
// The Stripe webhook needs the raw request body, so it is mounted before any JSON parser.
app.use('/api', stripeWebhook());
app.use('/api', bookingRoutes());
app.use(express.json());

app.post('/api/token', async (_req, res) => {
  const roomName = `call-${randomUUID().slice(0, 8)}`;
  const identity = `caller-${randomUUID().slice(0, 8)}`;

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '10m' });
  at.addGrant({ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true });
  // Explicit dispatch: the agent joins only rooms created with this config.
  at.roomConfig = new RoomConfiguration({
    agents: [new RoomAgentDispatch({ agentName: AGENT_NAME })],
  });

  // LiveKit's standard token-endpoint response, read by TokenSource.endpoint() in the browser.
  res.json({ server_url: LIVEKIT_URL, participant_token: await at.toJwt(), room_name: roomName });
});

// Last-resort error handler: log the details, give the browser a generic message.
app.use(
  (err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error('[api]', err);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  },
);

const port = Number(process.env.TOKEN_SERVER_PORT ?? 3001);
app.listen(port, () => {
  console.log(`token-server listening on http://localhost:${port}`);
  const on = (v: boolean) => (v ? 'on' : 'off');
  console.log(
    `[api] supabase=${on(supabaseEnabled)} stripe=${on(paymentsEnabled)} ` +
      `webhook=${on(webhookEnabled)} email=${on(emailEnabled)}`,
  );
  if (supabaseEnabled && paymentsEnabled) startHoldSweeper();
});
