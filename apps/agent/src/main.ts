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
import { fileURLToPath } from 'node:url';
import './config.ts';
import { greeting, instructions } from './prompt.ts';
import { createLlm, createStt, createTts, loadVad } from './providers.ts';

export default defineAgent({
  // Runs once per worker process, so the VAD model loads before calls arrive.
  prewarm: async (proc: JobProcess) => {
    proc.userData.vad = await loadVad();
  },

  entry: async (ctx: JobContext) => {
    const session = new voice.AgentSession({
      vad: ctx.proc.userData.vad as Awaited<ReturnType<typeof loadVad>>,
      stt: createStt(),
      llm: createLlm(),
      tts: createTts(),
      // Phase 1: let Deepgram's endpointing + VAD decide when the caller is done.
      // The LiveKit turn-detector model is evaluated in Phase 3.
      turnHandling: { turnDetection: 'stt' },
    });

    await session.start({ agent: new voice.Agent({ instructions }), room: ctx.room });
    await ctx.connect();

    session.generateReply({ instructions: greeting });
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
