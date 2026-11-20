// One factory per provider. Swapping a vendor means editing only this file.
import * as deepgram from '@livekit/agents-plugin-deepgram';
import * as openai from '@livekit/agents-plugin-openai';
import * as silero from '@livekit/agents-plugin-silero';
import { config } from './config.ts';

export function createStt() {
  return new deepgram.STT({
    apiKey: config.deepgramApiKey,
    model: config.sttModel,
    interimResults: true,
    smartFormat: true,
    punctuate: true,
    endpointing: 25,
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
  });
}

export function createTts() {
  return new deepgram.TTS({ apiKey: config.deepgramApiKey, model: config.ttsVoice });
}

export function loadVad() {
  return silero.VAD.load();
}
