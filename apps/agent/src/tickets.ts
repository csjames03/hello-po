// Support tickets, including handoffs to a human. A ticket is the agent's way of saying
// "a person will follow up", so it never has to invent an answer or promise it can't keep.
import { llm } from '@livekit/agents';
import { randomInt } from 'node:crypto';
import { z } from 'zod';
import { insertRow, updateRows } from './db.ts';
import { type Publish, runTool } from './tool-runner.ts';

// No 0/O or 1/I, so a code read aloud is not ambiguous.
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newTicketCode = () =>
  'TK-' + Array.from({ length: 5 }, () => alphabet[randomInt(alphabet.length)]).join('');

const digitWords: Record<string, string> = {
  zero: '0',
  oh: '0',
  one: '1',
  two: '2',
  three: '3',
  four: '4',
  five: '5',
  six: '6',
  seven: '7',
  eight: '8',
  nine: '9',
};

/**
 * Turns a spoken or written contact into one canonical form, so "c s james zero three at gmail
 * dot com" and "csjames03@gmail.com" compare equal. Explicit dots are kept: "c dot s" stays
 * "c.s", which is exactly the difference a caller corrects.
 */
export function canonicalContact(text: string): string {
  return text
    .toLowerCase()
    .replace(/\s+at\s+/g, '@')
    .replace(/\s+dot\s+/g, '.')
    .replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine)\b/g, (w) => digitWords[w]!)
    .replace(/[^a-z0-9@.+]/g, '');
}

/**
 * A phone number or email in canonical form, or null. Models sometimes fill a missing contact
 * with "unknown" or "none", and "declined" means the caller chose not to share one; none of
 * those are stored.
 */
const realContact = (contact?: string) =>
  contact && !/^(unknown|none|n\/?a|not provided|declined|-)$/i.test(contact.trim())
    ? canonicalContact(contact) || null
    : null;

/** Whether one of the agent's last few messages read this contact back to the caller. */
function readBackRecently(chatCtx: llm.ChatContext, contact: string): boolean {
  return chatCtx.items
    .filter((i): i is llm.ChatMessage => i.type === 'message' && i.role === 'assistant')
    .slice(-3)
    .some((m) => canonicalContact(m.textContent ?? '').includes(contact));
}
/**
 * Whether the agent asked for a phone number or email in its last few messages. Checked from
 * the conversation itself, because a fallback model claimed the caller "declined" without ever
 * asking.
 */
function askedForContactRecently(chatCtx: llm.ChatContext): boolean {
  return chatCtx.items
    .filter((i): i is llm.ChatMessage => i.type === 'message')
    .slice(-6)
    .some(
      (m) =>
        m.role === 'assistant' &&
        /\b(phone|number|e-?mail|contact|reach you|call you back)\b/i.test(m.textContent ?? ''),
    );
}

export interface TicketContext {
  /** Resolves to the calls.id of this call, or null when not logged (evals). */
  callId: Promise<string | null>;
  callRoom?: string;
  source: 'call' | 'eval';
}

// A callback promise needs somewhere to call back. For these, the tool asks for a contact first.
const needsCallback = new Set(['handoff', 'complaint', 'booking']);

export function createTicketTools(publish: Publish, context: TicketContext) {
  // Set once the tool has told the agent to ask; after that a ticket without a contact goes through.
  let toldToAsk = false;
  // Tickets created in this call, by category. A second request for the same category (usually
  // a corrected phone number or email) updates that ticket instead of opening a duplicate.
  const created = new Map<string, string>();
  let readBackRequested: string | null = null;
  return {
    createTicket: llm.tool({
      description:
        'Create a ticket so staff follow up: a handoff to a person, a complaint, a booking ' +
        'change, or a request or question you cannot answer. Only after the caller agrees.',
      parameters: z.object({
        category: z.enum(['handoff', 'complaint', 'request', 'question', 'booking']),
        summary: z.string().min(10).max(500).describe('What the caller needs, for staff'),
        callerName: z.string().optional(),
        contact: z
          .string()
          .optional()
          .describe('Phone or email for the callback, or "declined" if the caller won’t share one'),
        urgent: z.boolean().optional().describe('Safety issue or arrival today'),
      }),
      execute: (args, opts) =>
        runTool('createTicket', { category: args.category }, opts, publish, async () => {
          const contact = realContact(args.contact);
          // Without a contact, go ahead only if the caller was actually asked for one.
          if (
            !contact &&
            needsCallback.has(args.category) &&
            !toldToAsk &&
            !askedForContactRecently(opts.ctx.session.history)
          ) {
            toldToAsk = true;
            return (
              'Not created yet. First ask the caller, in one short sentence, for a phone number ' +
              'or email so the team can call them back. Then call createTicket again with it, ' +
              'or with contact "declined" if they would rather not share one.'
            );
          }
          // Spoken contacts are easy to mishear: save one only after reading it back. Each contact
          // is sent back for a read-back at most once, so an unusual phrasing can't loop.
          if (
            contact &&
            contact !== readBackRequested &&
            !readBackRecently(opts.ctx.session.history, contact)
          ) {
            readBackRequested = contact;
            return (
              `Not saved yet. Read the contact back exactly as it will be saved, "${contact}", ` +
              'spelling out any dots, and ask if it is right. When they confirm, call ' +
              'createTicket again with it.'
            );
          }
          const existing = created.get(args.category);
          if (existing) {
            // Keep the original summary; the update is usually just a corrected contact.
            const changes = {
              ...(contact ? { contact } : {}),
              ...(args.callerName ? { caller_name: args.callerName } : {}),
              ...(args.urgent ? { priority: 'urgent' } : {}),
            };
            if (Object.keys(changes).length === 0) {
              return `Ticket ${existing} already exists for this; no new ticket was needed.`;
            }
            const updated = await updateRows('tickets', `code=eq.${existing}`, changes);
            if (updated) {
              console.log(`[ticket] ${existing} updated`);
              return (
                `Ticket ${existing} updated, no new ticket. Confirm the change in a few words` +
                (contact ? ` and that the team will contact them at ${contact}.` : '.')
              );
            }
          }
          const code = newTicketCode();
          const saved = await insertRow('tickets', {
            code,
            call_id: await context.callId,
            call_room: context.callRoom ?? null,
            category: args.category,
            priority: args.urgent ? 'urgent' : 'normal',
            caller_name: args.callerName ?? null,
            contact,
            summary: args.summary,
            source: context.source,
          });
          if (!saved) {
            return (
              'The ticket system is not responding. Apologise, and ask the caller to call the ' +
              'front desk directly, which is open 24 hours.'
            );
          }
          created.set(args.category, code);
          console.log(`[ticket] ${code} ${args.category}${args.urgent ? ' urgent' : ''}`);
          if (args.category === 'handoff') {
            await publish({ type: 'handoff', ticketId: code, reason: args.summary });
          }
          const spelled = code.replace('TK-', '').split('').join(' ');
          const followUp = args.category === 'handoff' ? 'within 30 minutes' : 'within 24 hours';
          return (
            `Ticket ${code} created. Read the reference to the caller as "T K ${spelled}". ` +
            (contact
              ? `Say the team will contact them at ${contact} ${followUp}.`
              : `Say the team will pick it up ${followUp}, and that they can call the front ` +
                'desk any time and quote the reference.')
          );
        }),
    }),
  };
}
