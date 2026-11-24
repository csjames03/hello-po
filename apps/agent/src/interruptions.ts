// Measures how quickly the agent goes silent when the caller talks over it.
//
// stopMs = (agent audio paused or cleared) - (caller and agent start overlapping).
// The overlap starts when the caller talks over audible agent speech, or when agent audio starts
// while the caller is still talking.
//
// This watches the audio output itself rather than the agent's "speaking" state: after a pause
// the SDK can play the next reply without switching that state back, so state changes missed
// some interruptions. pause() and clearBuffer() are the exact moments the agent goes silent.
//
// The SDK only reports the caller as speaking once the VAD has heard `vadMinSpeechMs` of speech,
// so that start is backdated by that amount. Otherwise stop times would look ~100 ms better.
//
// If the SDK reports a false interruption (such as a cough) and resumes the reply, the record is
// marked `resumed` so tests can tell the two apart.
import type { InterruptEvent } from '@hello-po/shared';
import { voice } from '@livekit/agents';
import { vadMinSpeechMs } from './providers.ts';

export interface InterruptRecord extends InterruptEvent {
  /** True if the agent paused but then resumed the same audio (not a real interruption). */
  resumed: boolean;
}

/** Call after session.start(), once the audio output exists. */
export function onInterrupt(
  session: voice.AgentSession,
  handler: (record: InterruptRecord) => void,
) {
  const audio = session.output.audio;
  if (!audio) return;

  let turnId = 'unknown';
  let audible = false; // agent audio is playing and not paused
  let paused = false; // paused mid-playback; resume() makes it audible again
  let overlapStartedAt: number | undefined;
  let pending: InterruptRecord | undefined;

  const flush = () => {
    if (pending) handler(pending);
    pending = undefined;
  };

  const stopped = (isPause: boolean) => {
    if (!audible) return;
    audible = false;
    paused = isPause;
    if (overlapStartedAt === undefined) return; // stopped for another reason (e.g. hang-up)
    flush();
    pending = {
      type: 'interrupt',
      turnId,
      stopMs: Math.max(0, Math.round(Date.now() - overlapStartedAt)),
      resumed: false,
    };
    overlapStartedAt = undefined;
  };

  session.on(voice.AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => {
    turnId = speechHandle.id;
  });

  session.on(voice.AgentSessionEventTypes.UserStateChanged, ({ newState, createdAt }) => {
    if (newState === 'speaking' && audible && overlapStartedAt === undefined) {
      overlapStartedAt = createdAt - vadMinSpeechMs;
    } else if (newState === 'listening' && audible) {
      overlapStartedAt = undefined; // caller stopped and the agent kept talking
    }
  });

  audio.on(voice.AudioOutput.EVENT_PLAYBACK_STARTED, ({ createdAt }: { createdAt: number }) => {
    flush();
    audible = true;
    paused = false;
    overlapStartedAt = session.userState === 'speaking' ? createdAt : undefined;
  });
  audio.on(voice.AudioOutput.EVENT_PLAYBACK_FINISHED, () => {
    audible = false;
    paused = false;
    overlapStartedAt = undefined;
    flush();
  });

  const pause = audio.pause.bind(audio);
  const resume = audio.resume.bind(audio);
  const clearBuffer = audio.clearBuffer.bind(audio);
  audio.pause = () => {
    stopped(true);
    pause();
  };
  audio.clearBuffer = () => {
    stopped(false);
    paused = false;
    clearBuffer();
  };
  audio.resume = () => {
    if (paused) {
      audible = true;
      paused = false;
    }
    resume();
  };

  // The SDK also calls resume() internally while tearing down a real interruption, so only its
  // own false-interruption event says the reply actually carried on.
  session.on(voice.AgentSessionEventTypes.AgentFalseInterruption, ({ resumed: carriedOn }) => {
    if (carriedOn && pending) pending.resumed = true;
  });
}

export function formatInterrupt(r: InterruptRecord): string {
  return r.resumed
    ? `[interrupt] paused ${r.stopMs}ms then resumed (false interruption)`
    : `[interrupt] stop ${String(r.stopMs).padStart(4)}ms`;
}
