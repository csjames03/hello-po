// Shared wrapper for every tool: filler speech if the step is slow, a timing log line, and a
// `tool` event so the browser can show what the agent did.
import type { HelloPoEvent } from '@hello-po/shared';
import type { llm } from '@livekit/agents';

/** Sends an event to the browser. A no-op in text-only evals. */
export type Publish = (event: HelloPoEvent) => Promise<void>;

/**
 * Runs a tool step. The prompt asks Mara to say a few words before calling a tool, so the
 * caller rarely waits in silence; the filler only fires after a stretch of silence.
 */
export async function runTool<T>(
  name: string,
  args: Record<string, unknown>,
  opts: llm.ToolOptions,
  publish: Publish,
  fn: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  let ok = false;
  try {
    const result = await opts.ctx.filler('One moment, let me check that.', { delay: 900 }, fn);
    ok = true;
    return result;
  } finally {
    console.log(
      `[tool] ${name} ${Math.round(performance.now() - started)}ms${ok ? '' : ' (failed)'}`,
    );
    void publish({ type: 'tool', turnId: opts.ctx.speechHandle.id, name, args, ok }).catch(
      () => undefined,
    );
  }
}
