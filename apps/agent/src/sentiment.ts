// Scores the caller's mood on every turn with a small, separate Groq model.
//
// It runs in the background after each caller message, so it never delays a reply, and it uses
// a different model from the conversation (openai/gpt-oss-20b), which on Groq's free tier has
// its own rate limit. The latest score feeds a short note to Mara when the caller sounds upset,
// so she can de-escalate or offer a human.
import type { SentimentEvent } from '@hello-po/shared';
import { voice } from '@livekit/agents';
import { config } from './config.ts';

const model = process.env.SENTIMENT_MODEL ?? 'openai/gpt-oss-20b';

const instructions =
  'Rate the sentiment of a hotel guest speaking to a phone support agent. Consider tone and ' +
  'word choice, not the topic. Reply with only one number from -1 (very angry or upset) ' +
  'through 0 (neutral) to 1 (very happy). Examples: "this is ridiculous, I want a manager" ' +
  '= -0.8; "what time is check-in" = 0; "perfect, thank you so much" = 0.8.';

export const toLabel = (score: number): SentimentEvent['label'] =>
  score <= -0.3 ? 'negative' : score >= 0.3 ? 'positive' : 'neutral';

/** Returns a score from -1 to 1, or null if the model did not answer in time. */
export async function scoreSentiment(text: string, timeoutMs = 4000): Promise<number | null> {
  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.groqApiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: text },
        ],
        temperature: 0,
        reasoning_effort: 'low',
        max_completion_tokens: 200,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      console.warn(`[sentiment] ${res.status} ${(await res.text()).slice(0, 120)}`);
      return null;
    }
    const body = (await res.json()) as { choices: { message: { content: string | null } }[] };
    const match = body.choices[0]?.message.content?.match(/-?\d+(\.\d+)?/);
    if (!match) return null;
    return Math.max(-1, Math.min(1, Math.round(Number(match[0]) * 100) / 100));
  } catch (err) {
    console.warn('[sentiment] failed:', err instanceof Error ? err.message : err);
    return null;
  }
}

/** Scores every caller message in the background and reports each result. */
export function onCallerSentiment(
  session: voice.AgentSession,
  handler: (event: SentimentEvent, text: string) => void,
) {
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, ({ item }) => {
    if (item.type !== 'message' || item.role !== 'user') return;
    const text = item.textContent?.trim();
    if (!text) return;
    void scoreSentiment(text).then((score) => {
      if (score === null) return;
      handler({ type: 'sentiment', turnId: item.id, score, label: toLabel(score) }, text);
    });
  });
}

/** Tracks the caller's recent mood and turns it into a note for the agent when needed. */
export class MoodTracker {
  private scores: number[] = [];

  add(score: number) {
    this.scores = [...this.scores.slice(-2), score];
  }

  note(): string | null {
    const latest = this.scores.at(-1);
    if (latest === undefined || latest > -0.4) return null;
    const persistent = this.scores.filter((s) => s <= -0.4).length >= 2;
    return persistent
      ? 'The caller has sounded upset for several turns. Apologise sincerely and offer to have a ' +
          'staff member call them back, using createTicket with category handoff.'
      : 'The caller sounds frustrated. Acknowledge it briefly and kindly before answering.';
  }
}
