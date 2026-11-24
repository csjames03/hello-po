# Phase 3 results: interruptions (barge-in)

Measured on the agent deployed to LiveKit Cloud (`us-east`), with Deepgram Flux (`flux-general-en`), Groq `qwen/qwen3.8-27b`, and Deepgram `aura-2-asteria-en`. All calls were made from the Philippines through the browser, with headphones.

**Stop time** is the time from the moment the caller and the agent start talking at the same time to the moment the agent's audio is paused. The overlap starts either when the caller talks over the agent, or when agent audio starts while the caller is still talking. It is measured on the agent. Audio travelling between the caller and `us-east` adds network time on top, which is not measured here.

## Summary

| Configuration                                                 | Real interruptions | p50        | p95        | Max        | Under 300 ms |
| ------------------------------------------------------------- | ------------------ | ---------- | ---------- | ---------- | ------------ |
| Baseline: `minWords: 1`, `minDuration: 500` (default)         | 9                  | 947 ms     | 2,623 ms   | 2,623 ms   | 0 / 9        |
| **Phase 3: `mode: 'vad'`, `minWords: 0`, `minDuration: 200`** | **11**             | **199 ms** | **201 ms** | **201 ms** | **11 / 11**  |

**Acceptance (stop in < 300 ms across 10 interruption tests): PASS.**

The same calls kept reply latency inside the project target: voice to voice p50 **411 ms** and p95 **968 ms** over 21 turns.

## What was wrong

With `minWords: 1`, the SDK will not pause the agent until the speech-to-text has returned at least one word of the caller's speech. Deepgram is reached from `us-east`, and Flux returns words in chunks, so stop time depended on transcription timing and ranged from 481 ms to 2.6 s. The SDK default `minDuration` of 500 ms alone would also miss the target.

## What changed

- **VAD-only barge-in (`interruption.mode: 'vad'`, `minWords: 0`).** The local Silero VAD decides. The agent pauses after 200 ms of caller speech (`minDuration: 200`) without waiting for a transcript. LiveKit's cloud "adaptive" interruption model was not used, for the same reason: it is another network hop before the agent can stop.
- **False interruptions still recover.** If the pause was caused by a cough or noise and no words follow, the SDK resumes the reply after 1 s (`falseInterruptionTimeout: 1000`). If words follow, the reply is cancelled and the caller's turn is answered.
- **Fewer premature replies.** Flux's end-of-turn threshold (`eotThreshold`) went from 0.7 to 0.8, because short pauses ("Wait. … describe the restaurant") ended the turn and the agent started replying over the caller.

## How it is measured

[`apps/agent/src/interruptions.ts`](../../apps/agent/src/interruptions.ts) watches the session's audio output directly. `pause()` and `clearBuffer()` mark the instant the agent goes silent, and the playback events mark when it is audible. An earlier version used the agent's `speaking` state, but after a pause the SDK can play the next reply without switching that state back, so some interruptions were missed.

The SDK only reports the caller as speaking after the VAD has heard 100 ms of speech (`minSpeechDuration`), so the start is backdated by 100 ms. This makes the measured stop time strict rather than flattering.

False interruptions are identified with the SDK's `AgentFalseInterruption` event (`resumed: true`). An earlier version treated any `resume()` call as a false interruption, but the SDK also calls `resume()` while tearing down a real interruption. The three rows from call `call-bcf060ba` were saved with that bug and corrected in Supabase. The agent logs confirm each of those replies was cut off ("playout completed with interrupt").

## Known issues

- **A lone "Wait." can still start a reply.** Flux sometimes ends the turn after a short standalone word. The agent is cut off by the next words before anything is heard, but it starts generating early.
- **Not every interruption in the second Phase 3 call was recorded.** Before the measurement switched to the audio output, some cut-offs in call `call-bec62d1d` were missed. Every one that was measured stopped in about 200 ms.
- **Network time is not included.** The caller hears the agent stop slightly later than the agent stops sending audio.

## Raw data

From the `interruptions` table (`resumed` = the agent paused, then resumed the same reply).

| Time (UTC)          | Call            | Stop (ms) | Resumed | Configuration |
| ------------------- | --------------- | --------- | ------- | ------------- |
| 2026-11-23 19:31:27 | `call-96ea6cdf` | 947       | no      | baseline      |
| 2026-11-23 19:31:44 | `call-96ea6cdf` | 2224      | yes*    | baseline      |
| 2026-11-23 19:32:30 | `call-4ee4742e` | 701       | no      | baseline      |
| 2026-11-23 19:32:43 | `call-4ee4742e` | 1222      | yes*    | baseline      |
| 2026-11-23 19:33:00 | `call-4ee4742e` | 537       | no      | baseline      |
| 2026-11-23 19:33:08 | `call-4ee4742e` | 2028      | no      | baseline      |
| 2026-11-23 19:33:21 | `call-4ee4742e` | 807       | yes*    | baseline      |
| 2026-11-23 19:33:32 | `call-4ee4742e` | 481       | no      | baseline      |
| 2026-11-23 19:33:54 | `call-4ee4742e` | 2623      | yes*    | baseline      |
| 2026-11-23 19:44:10 | `call-28edfbf8` | 199       | no      | Phase 3       |
| 2026-11-23 19:44:28 | `call-28edfbf8` | 200       | no      | Phase 3       |
| 2026-11-23 19:44:37 | `call-28edfbf8` | 190       | no      | Phase 3       |
| 2026-11-23 19:44:43 | `call-28edfbf8` | 199       | no      | Phase 3       |
| 2026-11-23 19:44:48 | `call-28edfbf8` | 198       | no      | Phase 3       |
| 2026-11-23 19:52:51 | `call-bec62d1d` | 199       | no      | Phase 3       |
| 2026-11-23 19:52:52 | `call-bec62d1d` | 201       | no      | Phase 3       |
| 2026-11-23 19:52:59 | `call-bec62d1d` | 193       | no      | Phase 3       |
| 2026-11-23 20:06:36 | `call-bcf060ba` | 200       | no      | Phase 3       |
| 2026-11-23 20:06:46 | `call-bcf060ba` | 200       | no      | Phase 3       |
| 2026-11-23 20:06:53 | `call-bcf060ba` | 191       | no      | Phase 3       |

\* The first measurement version misclassified these as false interruptions, but the transcript and agent logs show each reply was cut off. The baseline summary counts all nine as real. Counting only the five rows marked `no` gives the same result: none under 300 ms.

Reproduce the Phase 3 summary with:

```bash
npm run latency:report -- --since 2026-11-23T19:40 --last 100
```
