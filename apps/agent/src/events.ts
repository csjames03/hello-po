// Publishes Hello Po events to the browser over the LiveKit data channel.
import { EVENTS_TOPIC, type HelloPoEvent } from '@hello-po/shared';
import type { Room } from '@livekit/rtc-node';

const encoder = new TextEncoder();

export async function publishEvent(room: Room, event: HelloPoEvent): Promise<void> {
  try {
    await room.localParticipant?.publishData(encoder.encode(JSON.stringify(event)), {
      reliable: true,
      topic: EVENTS_TOPIC,
    });
  } catch (err) {
    console.warn('[events] publish failed:', err);
  }
}
