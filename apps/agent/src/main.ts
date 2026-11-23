// Hello Po agent worker: joins each call room and runs STT -> LLM -> TTS.
import { AGENT_NAME } from '@hello-po/shared';
import {
  type JobContext,
  type JobProcess,
  ServerOptions,
  cli,
  defineAgent,
  voice,
} from '@livekit/agents';
import { ParticipantKind } from '@livekit/rtc-node';
import { fileURLToPath } from 'node:url';
import { config } from './config.ts';
import { createCall, dbEnabled, endCall, insertTurn } from './db.ts';
import { publishEvent } from './events.ts';
import { formatTurn, onTurnLatency } from './latency.ts';
import { greeting, instructions } from './prompt.ts';
import { createLlm, createStt, createTts, endpointingMinDelayMs, loadVad } from './providers.ts';
import { appendLocalTurn } from './turn-log.ts';

export default defineAgent({
  // Runs once per worker process, so the VAD model loads before calls arrive.
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await loadVad();
  },

  entry: async (ctx: JobContext) => {
    // Known from the job before joining; ctx.room.name is only set after connect().
    const roomName = ctx.job.room?.name ?? 'unknown';

    await ctx.connect();

    // A cold start can make LiveKit dispatch a second job to the same room. If two agents
    // meet, the one with the lower identity stays, so exactly one remains.
    const myIdentity = ctx.room.localParticipant?.identity ?? '';
    const earlierAgent = [...ctx.room.remoteParticipants.values()].find(
      (p) => p.kind === ParticipantKind.AGENT && p.identity < myIdentity,
    );
    if (earlierAgent) {
      console.warn(`[call] ${roomName}: agent ${earlierAgent.identity} already here, leaving`);
      ctx.shutdown('duplicate agent');
      return;
    }

    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as Awaited<ReturnType<typeof loadVad>>,
      stt: createStt(),
      llm: createLlm(),
      tts: createTts(),
      // Let STT endpointing (or Flux's built-in end-of-turn) decide when the caller is done.
      // The LiveKit turn-detector model is evaluated in Phase 3.
      turnHandling: {
        turnDetection: 'stt',
        // Wait after STT end-of-speech before committing the turn. The SDK default (500 ms)
        // alone used most of the 800 ms budget.
        endpointing: { minDelay: endpointingMinDelayMs },
        interruption: {
          // Only a real word interrupts the agent. Noise alone paused replies for 1-2 s.
          minWords: 1,
          // If an interruption turns out to be false, resume after 1 s (default 2 s).
          falseInterruptionTimeout: 1000,
        },
      },
    });

    // Surface provider errors (rate limits, timeouts) that would otherwise only show as silence.
    session.on(voice.AgentSessionEventTypes.Error, ({ error, source }) => {
      console.error(`[error] ${source?.constructor.name ?? 'session'}:`, error);
    });

    // Log every turn's latency to the console, the browser, and Supabase.
    const callIdPromise = createCall(roomName);
    onTurnLatency(session, async (turn) => {
      console.log(formatTurn(turn));
      void appendLocalTurn(turn, roomName);
      const { userText, agentText, ...event } = turn;
      void publishEvent(ctx.room, event);

      const callId = await callIdPromise;
      if (!callId) return;
      void insertTurn({
        call_id: callId,
        turn_id: turn.turnId,
        user_text: userText,
        agent_text: agentText,
        eot_ms: turn.eotMs,
        stt_ms: turn.sttMs,
        llm_ttft_ms: turn.llmFirstTokenMs,
        tts_ttfb_ms: turn.ttsFirstAudioMs,
        e2e_ms: turn.totalMs,
        interrupted: turn.interrupted,
      });
    });
    // Record the end time when the session closes (caller hangs up), with the process
    // shutdown as a fallback. Whichever fires first wins.
    let ended = false;
    const markEnded = async () => {
      if (ended) return;
      ended = true;
      const callId = await callIdPromise;
      if (callId) await endCall(callId);
    };
    session.on(voice.AgentSessionEventTypes.Close, () => void markEnded());
    ctx.addShutdownCallback(markEnded);

    await session.start({ agent: new voice.Agent({ instructions }), room: ctx.room });

    console.log(
      `[call] ${roomName} | stt=${config.sttModel} llm=${config.llmModel} ` +
        `tts=${config.ttsVoice} | supabase=${dbEnabled ? 'on' : 'off'}`,
    );
    session.say(greeting);
  },
});

cli.runApp(
  new ServerOptions({
    agent: fileURLToPath(import.meta.url),
    agentName: AGENT_NAME,
    // Keep memory low during local development.
    numIdleProcesses: 1,
  }),
);
