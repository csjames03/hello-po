// Mints a LiveKit access token for one call and dispatches the Hello Po agent into its room.
import { AGENT_NAME } from '@hello-po/shared';
import { RoomAgentDispatch, RoomConfiguration } from '@livekit/protocol';
import dotenv from 'dotenv';
import express from 'express';
import { AccessToken } from 'livekit-server-sdk';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

const { LIVEKIT_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET } = process.env;
if (!LIVEKIT_URL || !LIVEKIT_API_KEY || !LIVEKIT_API_SECRET) {
  throw new Error('Missing LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET in .env');
}

const app = express();
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

const port = Number(process.env.TOKEN_SERVER_PORT ?? 3001);
app.listen(port, () => console.log(`token-server listening on http://localhost:${port}`));
