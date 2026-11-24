// One factory per provider. Swapping a vendor means editing only this file.
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { config } from './config.ts';
import { keyterms } from './prompt.ts';

/** Flux is Deepgram's voice-agent model with built-in, meaning-aware end-of-turn detection. */
export const isFlux = config.sttModel.startsWith('flux');

export function createStt() {
  if (isFlux) {
    return new deepgram.STTv2({
      apiKey: config.deepgramApiKey,
      model: config.sttModel,
      keyterms,
      // "Probably done" signal; the SDK starts the LLM early on it (preemptive generation).
      eagerEotThreshold: 0.5,
      // Confidence needed for the final end of turn (Deepgram default 0.7). At 0.7 a short
      // pause ("Wait. ... describe the restaurant") ended the turn and the agent talked over
      // the caller.
      eotThreshold: 0.8,
    });
  }
  return new deepgram.STT({
    apiKey: config.deepgramApiKey,
    model: config.sttModel,
    interimResults: true,
    smartFormat: true,
    punctuate: true,
    // Silence (ms) before Deepgram marks speech ended. 25 fired mid-sentence on every short pause.
    endpointing: 75,
    keyterm: keyterms,
  });
}

export function createLlm() {
  // Groq speaks the OpenAI chat API, so the OpenAI plugin works with a different base URL.
  return new openai.LLM({
    apiKey: config.groqApiKey,
    baseURL: 'https://api.groq.com/openai/v1',
    model: config.llmModel,
    // Qwen3 "thinks" before answering unless told not to, which adds latency.
    reasoningEffort: 'none',
    temperature: 0.4,
    // Spoken replies are one to three sentences. Groq's free tier also caps output tokens per
    // minute and budgets each request at its max_tokens, so an unset limit can trigger 429s.
    maxCompletionTokens: 150,
  });
}

export function createTts() {
  return new deepgram.TTS({ apiKey: config.deepgramApiKey, model: config.ttsVoice });
}

/** Speech the VAD must hear before it reports the caller as speaking. Ignores clicks and pops. */
export const vadMinSpeechMs = 100;

export function loadVad() {
  return silero.VAD.load({
    // Default 0.5 treated background noise and breathing as speech, causing false interruptions.
    activationThreshold: 0.6,
    minSpeechDuration: vadMinSpeechMs,
  });
}

/**
 * Extra wait after the STT says speech ended, before committing the turn.
 * Flux already weighs pauses and meaning, so it needs none. Nova-3 only detects silence.
 */
export const endpointingMinDelayMs = isFlux ? 0 : 200;
