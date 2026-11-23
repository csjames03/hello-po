// Turns the SDK's per-message metrics into one latency record per agent reply.
//
// The SDK attaches a MetricsReport to each chat message (values in seconds):
// - user message:      endOfTurnDelay, transcriptionDelay
// - assistant message: llmNodeTtft, ttsNodeTtfb, e2eLatency
// e2eLatency is voice to voice: user stopped speaking -> agent started speaking.
import type { LatencyEvent } from '@hello-po/shared';
import { type llm, voice } from '@livekit/agents';

export interface TurnLatency extends LatencyEvent {
  userText: string | null;
  agentText: string | null;
}

const toMs = (seconds: number | undefined) =>
  seconds === undefined ? null : Math.round(seconds * 1000);

export function onTurnLatency(session: voice.AgentSession, handler: (turn: TurnLatency) => void) {
  let lastUser: llm.ChatMessage | undefined;

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message') return;

    if (item.role === 'user') {
      lastUser = item;
      return;
    }
    // Replies without a preceding user turn (like the greeting) have no e2e latency.
    if (item.role !== 'assistant' || item.metrics.e2eLatency === undefined) return;

    handler({
      type: 'latency',
      turnId: item.id,
      eotMs: toMs(lastUser?.metrics.endOfTurnDelay),
      sttMs: toMs(lastUser?.metrics.transcriptionDelay),
      llmFirstTokenMs: toMs(item.metrics.llmNodeTtft),
      ttsFirstAudioMs: toMs(item.metrics.ttsNodeTtfb),
      totalMs: toMs(item.metrics.e2eLatency)!,
      interrupted: item.interrupted,
      userText: lastUser?.textContent ?? null,
      agentText: item.textContent ?? null,
    });
    lastUser = undefined;
  });
}

export function formatTurn(t: TurnLatency): string {
  const f = (v: number | null) => (v === null ? '  -  ' : `${String(v).padStart(4)}ms`);
  return (
    `[latency] total ${f(t.totalMs)} | eot ${f(t.eotMs)} | stt ${f(t.sttMs)} | ` +
    `llm ${f(t.llmFirstTokenMs)} | tts ${f(t.ttsFirstAudioMs)}${t.interrupted ? ' | interrupted' : ''}`
  );
}
