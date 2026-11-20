// Events sent from the agent to the browser over the LiveKit data channel.
// Both apps import from here so the wire format can't drift.

/** Data channel topic for all Hello Po events. */
export const EVENTS_TOPIC = 'hello-po.events';

export type Speaker = 'user' | 'agent';

export interface TranscriptEvent {
  type: 'transcript';
  turnId: string;
  speaker: Speaker;
  text: string;
  final: boolean;
  ts: number;
}

export interface SentimentEvent {
  type: 'sentiment';
  turnId: string;
  /** -1 (very negative) .. 1 (very positive) */
  score: number;
  label: 'negative' | 'neutral' | 'positive';
}

export interface LatencyEvent {
  type: 'latency';
  turnId: string;
  eotMs: number;
  sttMs: number;
  llmFirstTokenMs: number;
  ttsFirstAudioMs: number;
  totalMs: number;
}

export interface InterruptEvent {
  type: 'interrupt';
  turnId: string;
  stopMs: number;
}

export interface ToolEvent {
  type: 'tool';
  turnId: string;
  name: string;
  args: Record<string, unknown>;
  ok: boolean;
}

export interface HandoffEvent {
  type: 'handoff';
  ticketId: string;
  reason: string;
}

export type HelloPoEvent =
  TranscriptEvent | SentimentEvent | LatencyEvent | InterruptEvent | ToolEvent | HandoffEvent;

/** Agent identity used for dispatch, so token server and worker agree. */
export const AGENT_NAME = 'hello-po-agent';
