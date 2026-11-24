# Roadmap

Hello Po is built in phases. Each phase ends with something that can be demonstrated, and has explicit acceptance criteria.

| Phase                                        | Focus                           | Status  |
| -------------------------------------------- | ------------------------------- | ------- |
| [1](#phase-1--mvp)                           | MVP: working voice call         | Done    |
| [2](#phase-2--latency)                       | Latency                         | Done    |
| [3](#phase-3--interruptions-and-turn-taking) | Interruptions and turn-taking   | Done    |
| [4](#phase-4--brain)                         | Knowledge, tools, and sentiment | Next    |
| [5](#phase-5--ui-observability-and-evals)    | UI, observability, and evals    | Planned |
| [6](#phase-6--ship)                          | Deployment and guardrails       | Planned |

---

## Project goals

| Goal                      | Target                               |
| ------------------------- | ------------------------------------ |
| Voice-to-voice reply time | p50 < 800 ms, p95 < 1,200 ms         |
| Interruption stop time    | < 300 ms                             |
| Eval pass rate            | ≥ 85%                                |
| Hallucination rate        | < 5%                                 |
| Monthly running cost      | $0, free tiers only, no card on file |

---

## Phase 1 — MVP

**Goal:** a working, unpolished end-to-end voice call.

- [x] npm workspaces monorepo with shared TypeScript, ESLint, and Prettier configuration
- [x] Token server that mints LiveKit tokens and dispatches the agent to the room
- [x] Web page with **Call support** / **Hang up**, call status, and a plain live transcript
- [x] Agent that joins, greets the caller, and runs Deepgram STT → Groq LLM → Deepgram TTS
- [x] Resort persona prompt with a small set of hard-coded facts
- [x] Each provider behind a factory, so swapping one is a one-file change

**Acceptance:** call from the browser, talk, hear spoken replies, and see the transcript locally (any latency). ✅

---

## Phase 2 — Latency

**Goal:** measure every stage of every turn and get the median reply under one second.

- [x] Streaming end to end: interim transcripts, LLM token streaming, TTS starting on the first full sentence, and preemptive LLM generation on Flux's early end-of-turn signal
- [x] Per-turn stage timings from the SDK: end of turn, STT final, LLM first token, TTS first audio, voice-to-voice total
- [x] `latency` events to the browser (live table), `[latency]` console lines, and a local `logs/turns.jsonl`
- [x] Supabase schema for `calls` and `turns` (`supabase/migrations/`) and the logging code
- [x] Compared Deepgram Flux against Nova-3; Flux is the default
- [x] Tuned turn-taking: endpointing delay, noise-resistant interruptions, VAD threshold
- [x] Fixed silent replies (Groq output-token limit) and the greeting request error
- [x] Deployed the agent to LiveKit Cloud `us-east`, next to Deepgram
- [x] `npm run latency:report` prints p50 / p95 per stage
- [x] Applied the Supabase migrations (`0001` tables, `0002` grants for the server role only); calls and turns are logged by the deployed agent
- [ ] Re-validate the LLM choice (`openai/gpt-oss-20b`) with real calls (carried over)

**Acceptance:** p50 voice-to-voice < 1 s over 20 turns, with a printed p50 / p95 summary. ✅ **p50 450 ms, p95 945 ms over 22 turns** ([raw data](results/phase-2-cloud-latency.log)).

---

## Phase 3 — Interruptions and turn-taking

**Goal:** natural conversation, where the caller can cut in and the agent doesn't talk over them.

- [x] Measured the baseline: waiting for one transcribed word (`minWords: 1`) stopped in 481–2,623 ms, 0 of 9 under 300 ms
- [x] Barge-in decided by the local VAD (`mode: 'vad'`, `minWords: 0`, `minDuration: 200`); false interruptions resume after 1 s
- [x] Barge-in pauses TTS playback at once and cancels the reply when the caller's words arrive
- [x] Emit `interrupt` events with the measured stop time: browser panel, `[interrupt]` console lines, `logs/interrupts.jsonl`, and the Supabase `interruptions` table (migration `0003`)
- [x] Stop time measured from the audio output itself, with the VAD's 100 ms detection delay counted
- [x] Fewer premature replies: Flux end-of-turn threshold raised from 0.7 to 0.8
- [x] `npm run latency:report -- --since <time>` scores only runs after a configuration change
- [ ] A lone "Wait." can still end the turn early; the reply is cut off before it is heard (carried over)
- [ ] Evaluate the LiveKit turn-detector model against Flux end-of-turn (carried over; Flux already meets the latency target without its ~450 MB of weights)

**Acceptance:** the agent stops speaking in < 300 ms across 10 interruption tests. ✅ **11 / 11 under 300 ms, p50 199 ms, max 201 ms** ([results](results/phase-3-interruptions.md)).

---

## Phase 4 — Brain

**Goal:** answers grounded in real resort information, with actions the agent can take.

- [ ] Markdown knowledge base: hours, check-in and check-out, amenities, cancellation and refund policy
- [ ] Simple retrieval over the knowledge base (keyword or embedding search)
- [ ] Tools:
  - [ ] `checkAvailability`: room availability (mock data)
  - [ ] `lookupBooking`: find a booking by name and booking code (mock data)
  - [ ] `createTicket`: create a support ticket with a call summary (Supabase)
- [ ] Human handoff when the caller is angry, asks for a person, or is out of scope: create a ticket and say so politely
- [ ] Guardrails: never invent policies, prices, or bookings; confirm details before acting
- [ ] Sentiment score per caller turn, computed off the main reply path so it adds no latency
- [ ] Emit `tool`, `sentiment`, and `handoff` events

**Acceptance:** ≥ 85% correct outcomes across 20 scripted calls.

---

## Phase 5 — UI, observability, and evals

**Goal:** a stranger can understand what is happening on screen without explanation.

- [ ] Live transcript with speaker labels
- [ ] Sentiment panel: a chip per turn plus a running trend line
- [ ] Latency waterfall per turn
- [ ] `/metrics` page: p50 / p95 latency, interruption stop time, and eval pass rate, read from Supabase
- [ ] `evals/`: 20+ scripted, text-driven conversations through the same agent logic
- [ ] LLM-as-judge scoring for correctness and grounding; results saved to Supabase

**Acceptance:** the UI is self-explanatory, and the metrics page shows real data.

---

## Phase 6 — Ship

**Goal:** a public, passcode-protected demo that can't run up a bill.

- [ ] Deploy the agent to LiveKit Cloud
- [ ] Deploy the web app and token endpoint to Vercel
- [ ] Cost guardrails:
  - [ ] No card on file with any provider
  - [ ] Hard two-minute session limit; the agent says goodbye and disconnects
  - [ ] Passcode gate on the token endpoint
  - [ ] At most 3 calls per IP per day
  - [ ] At most 2 concurrent calls; extra callers see a "line busy" message
  - [ ] LLM rate-limit (429) handling: short filler, retry with backoff, then apologise and offer a ticket
  - [ ] A "demo paused" switch checked before any call starts
- [ ] README with a demo GIF, measured numbers, and one-command setup
- [ ] Case study: problem, architecture, key decisions, results, next steps

**Acceptance:** the live link works behind a passcode, and the README shows real measured numbers.

---

## Stretch goals

Considered only after Phase 6:

- Local mode (faster-whisper + Ollama + Piper) with a latency comparison
- Text-chat fallback for visitors without a microphone
- Post-call summary and automatic QA score
- Eval suite in CI that fails on latency or accuracy regressions
- Taglish (Tagalog-English) support
