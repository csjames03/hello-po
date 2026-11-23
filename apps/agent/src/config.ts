// Loads the repo-root .env and exposes typed config for the agent.
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)), quiet: true });

// The SDK preloads a ~450 MB local turn-detector model by default. Phase 1 doesn't use it.
process.env.LIVEKIT_AGENTS_PRELOAD_LOCAL_INFERENCE ??= '0';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing env var ${name}. Copy .env.example to .env and fill it in.`);
  return value;
}

export const config = {
  deepgramApiKey: required('DEEPGRAM_API_KEY'),
  groqApiKey: required('GROQ_API_KEY'),
  // Groq retired its Llama chat models; Qwen3 with thinking off was the fastest steady option.
  llmModel: process.env.LLM_MODEL ?? 'qwen/qwen3.8-27b',
  // Flux measured faster than Nova-3 (p50 1362 ms vs ~1500 ms) with no cut-offs.
  sttModel: process.env.STT_MODEL ?? 'flux-general-en',
  ttsVoice: process.env.TTS_VOICE ?? 'aura-2-asteria-en',
  // Optional: without these, turns are only logged to the console.
  supabaseUrl: process.env.SUPABASE_URL?.replace(/\/+$/, ''),
  supabaseSecretKey: process.env.SUPABASE_SECRET_KEY,
};
