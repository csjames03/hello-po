// Grounds each reply in the resort knowledge base.
//
// Before every LLM call, the passages that best match the caller's latest question are added to
// the context the LLM sees. This happens inside llmNode, on a copy of the chat context, rather
// than in onUserTurnCompleted: changing the context there would discard the SDK's preemptive
// generation and make every reply slower. Only the top few passages are sent, so the prompt
// stays well inside Groq's free-tier token budget.
import { KnowledgeBase } from '@hello-po/kb';
import { llm, voice } from '@livekit/agents';
import { type ReadableStream, TransformStream } from 'node:stream/web';

export const knowledgeBase = new KnowledgeBase();

/** Text of the most recent user messages, newest last. */
function recentUserText(chatCtx: llm.ChatContext, count: number): string[] {
  return chatCtx.items
    .filter((i): i is llm.ChatMessage => i.type === 'message' && i.role === 'user')
    .slice(-count)
    .map((m) => m.textContent ?? '')
    .filter(Boolean);
}

/** Builds the reference note for a question, or null when nothing relevant was found. */
export function knowledgeNote(chatCtx: llm.ChatContext): string | null {
  const recent = recentUserText(chatCtx, 2);
  const latest = recent.at(-1);
  const previous = recent.length > 1 ? recent[0] : undefined;
  if (!latest) return null;
  // Follow-ups like "and how much is it?" need the previous question for context.
  let hits = knowledgeBase.search(latest, 2);
  if (hits.length === 0 && previous) hits = knowledgeBase.search(`${previous} ${latest}`, 2);
  if (hits.length === 0) return null;
  console.log(`[kb] ${hits.map((h) => h.id).join(', ')}`);
  return (
    'Resort reference for the caller’s latest message. Use it only if relevant, and do not ' +
    'add facts that are not here:\n' +
    hits.map((h) => `- ${h.title}: ${h.text}`).join('\n')
  );
}

/** Adds the knowledge note just before the caller's latest message, on a copy of the context. */
export function withKnowledge(
  chatCtx: llm.ChatContext,
  extraNotes: string[] = [],
): llm.ChatContext {
  const notes = [knowledgeNote(chatCtx), ...extraNotes].filter((n): n is string => Boolean(n));
  if (notes.length === 0) return chatCtx;
  const lastUser = chatCtx.items
    .filter((i): i is llm.ChatMessage => i.type === 'message' && i.role === 'user')
    .at(-1);
  const ctx = chatCtx.copy();
  ctx.insert(
    llm.ChatMessage.create({
      role: 'system',
      content: [notes.join('\n\n')],
      createdAt: lastUser ? lastUser.createdAt - 1 : Date.now(),
    }),
  );
  return ctx;
}

/** Mara: the voice agent, with knowledge-base grounding and an optional caller-mood note. */
export class MaraAgent extends voice.Agent {
  private readonly moodNote: () => string | null;

  constructor(options: voice.AgentOptions<unknown> & { moodNote?: () => string | null }) {
    const { moodNote, ...agentOptions } = options;
    super(agentOptions);
    this.moodNote = moodNote ?? (() => null);
  }

  override async llmNode(
    chatCtx: llm.ChatContext,
    toolCtx: llm.ToolContext,
    modelSettings: voice.ModelSettings,
  ) {
    const mood = this.moodNote();
    const stream = await voice.Agent.default.llmNode(
      this,
      withKnowledge(chatCtx, mood ? [mood] : []),
      toolCtx,
      modelSettings,
    );
    return stream && stopRunawayFiller(stream);
  }
}

type LlmOutput = llm.ChatChunk | string;

/**
 * Ends a reply that degenerates into filler ("… … … …"). A fallback model did this under rate
 * limiting, and the text-to-speech would otherwise read it out. Normal replies never contain
 * more than a few punctuation-only chunks in a row.
 */
export function stopRunawayFiller(stream: ReadableStream<LlmOutput>): ReadableStream<LlmOutput> {
  let fillerRun = 0;
  let stopped = false;
  return stream.pipeThrough(
    new TransformStream<LlmOutput, LlmOutput>({
      transform(chunk, controller) {
        if (stopped) return;
        const text = typeof chunk === 'string' ? chunk : chunk.delta?.content;
        if (text) {
          fillerRun = /^[\s.…]+$/.test(text) ? fillerRun + 1 : 0;
          if (fillerRun > 2) {
            stopped = true;
            console.warn('[llm] reply degenerated into filler; cut it off');
            return;
          }
        }
        controller.enqueue(chunk);
      },
    }),
  );
}
