# Roadmap

Hello Po is built in phases. Each phase ends with something that can be demonstrated, and has explicit acceptance criteria.

| Phase                                        | Focus                           | Status  |
| -------------------------------------------- | ------------------------------- | ------- |
| [1](#phase-1--mvp)                           | MVP: working voice call         | Done    |
| [2](#phase-2--latency)                       | Latency                         | Next    |
| [3](#phase-3--interruptions-and-turn-taking) | Interruptions and turn-taking   | Planned |
| [4](#phase-4--brain)                         | Knowledge, tools, and sentiment | Planned |
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

- [ ] Confirm streaming end to end: interim transcripts, LLM token streaming, TTS starting on the first full sentence
- [ ] Timestamp each stage boundary per turn: end of turn, STT final, LLM first token, TTS first audio
- [ ] Emit `latency` events to the browser and log each turn to the console
- [ ] Supabase schema for `calls` and `turns`; persist timings for every turn
- [ ] Compare Deepgram Flux (built-in end-of-turn detection) against Nova-3
- [ ] Re-validate the LLM choice with real end-to-end numbers
- [ ] Confirm the nearest LiveKit region and measure transport overhead
- [ ] Summary script that prints p50 / p95 and a per-stage breakdown

**Acceptance:** p50 voice-to-voice < 1 s over 20 turns, with a printed p50 / p95 summary.

---

## Phase 3 — Interruptions and turn-taking

**Goal:** natural conversation, where the caller can cut in and the agent doesn't talk over them.

- [ ] Tune VAD and turn detection for filler words ("um"), short pauses, and background noise
- [ ] Evaluate the LiveKit turn-detector model against STT endpointing, weighing accuracy, latency, and memory
- [ ] Barge-in cancels in-flight LLM generation and TTS playback
- [ ] Emit `interrupt` events with the measured stop time
- [ ] The agent waits for the caller to finish instead of talking over them

**Acceptance:** the agent stops speaking in < 300 ms across 10 interruption tests.

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
