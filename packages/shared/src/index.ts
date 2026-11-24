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

/**
 * Per-turn latency, measured by the agent. All values in milliseconds.
 * Stage values are null when the SDK did not report that stage for the turn.
 * Stages can overlap (the LLM may start before the turn is committed), so
 * they do not necessarily sum to totalMs.
 */
export interface LatencyEvent {
  type: 'latency';
  turnId: string;
  /** End of user speech -> turn committed. */
  eotMs: number | null;
  /** End of user speech -> final transcript. */
  sttMs: number | null;
  /** LLM request -> first token. */
  llmFirstTokenMs: number | null;
  /** First text sent to TTS -> first audio. */
  ttsFirstAudioMs: number | null;
  /** Voice to voice: user stopped speaking -> agent started speaking. */
  totalMs: number;
  /** True if the caller interrupted this reply. */
  interrupted: boolean;
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

// ---------- Booking flow (Phase 4a) ----------

/** A room type the caller can book for the requested stay. Amounts are whole pesos. */
export interface BookingOption {
  roomTypeId: string;
  name: string;
  description: string;
  maxGuests: number;
  nightlyRate: number;
  nights: number;
  totalAmount: number;
  roomsLeft: number;
}

/** Agent -> browser: show a booking form in the chat, prefilled from the conversation. */
export interface BookingOfferEvent {
  type: 'booking_offer';
  offerId: string;
  checkIn: string; // YYYY-MM-DD
  checkOut: string; // YYYY-MM-DD, the departure day
  guests: number;
  options: BookingOption[];
  selectedRoomTypeId?: string;
  guestName?: string;
  guestEmail?: string;
}

export type BookingStatus = 'held' | 'confirmed' | 'expired' | 'cancelled' | 'failed';

/** Browser -> agent: what happened to the booking after the caller used the form. */
export interface BookingUpdateEvent {
  type: 'booking_update';
  status: BookingStatus;
  code?: string;
  roomName?: string;
  checkIn?: string;
  checkOut?: string;
  guestName?: string;
  paymentOption?: PaymentOption;
  amountPaid?: number;
  totalAmount?: number;
  holdExpiresAt?: string;
  reason?: string;
}

export type PaymentOption = 'full' | 'deposit';

/** Booking rules shared by the agent, the server, and the form. */
export const BOOKING_RULES = {
  currency: 'PHP',
  holdMinutes: 10,
  depositPercent: 50,
  maxNights: 14,
} as const;

/** Formats whole pesos for display, e.g. 14400 -> "₱14,400". */
export const formatPeso = (amount: number) => `₱${amount.toLocaleString('en-PH')}`;

export type HelloPoEvent =
  | TranscriptEvent
  | SentimentEvent
  | LatencyEvent
  | InterruptEvent
  | ToolEvent
  | HandoffEvent
  | BookingOfferEvent
  | BookingUpdateEvent;

/** Agent identity used for dispatch, so token server and worker agree. */
export const AGENT_NAME = 'hello-po-agent';
