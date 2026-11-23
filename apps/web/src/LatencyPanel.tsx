import { EVENTS_TOPIC, type HelloPoEvent, type LatencyEvent } from '@hello-po/shared';
import { useDataChannel } from '@livekit/components-react';
import { useState } from 'react';

const decoder = new TextDecoder();

// Colour the total against the project targets: p50 < 800 ms, p95 < 1200 ms.
function totalClass(ms: number) {
  if (ms < 800) return 'text-emerald-400';
  if (ms < 1200) return 'text-amber-400';
  return 'text-rose-400';
}

const cell = (v: number | null) => (v === null ? '–' : `${v}`);

/** Live per-turn latency, from `latency` events published by the agent. */
export function LatencyPanel() {
  const [turns, setTurns] = useState<LatencyEvent[]>([]);

  useDataChannel(EVENTS_TOPIC, (msg) => {
    const event = JSON.parse(decoder.decode(msg.payload)) as HelloPoEvent;
    if (event.type === 'latency') setTurns((prev) => [...prev, event]);
  });

  return (
    <section className="rounded-lg border border-slate-800 p-4">
      <h2 className="mb-1 text-sm font-medium text-slate-300">Latency per turn (ms)</h2>
      <p className="mb-3 text-xs text-slate-500">
        Total = you stop speaking → agent starts speaking. Target under 800.
      </p>
      {turns.length === 0 ? (
        <p className="text-sm text-slate-500">Appears after the agent's first reply to you.</p>
      ) : (
        <table className="w-full text-right text-sm tabular-nums">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="text-left font-normal">Turn</th>
              <th className="font-normal">Total</th>
              <th className="font-normal">End of turn</th>
              <th className="font-normal">STT</th>
              <th className="font-normal">LLM 1st token</th>
              <th className="font-normal">TTS 1st audio</th>
            </tr>
          </thead>
          <tbody>
            {turns.map((t, i) => (
              <tr key={t.turnId} className="border-t border-slate-800">
                <td className="py-1 text-left text-slate-400">
                  {i + 1}
                  {t.interrupted && <span className="ml-1 text-xs text-slate-500">(cut off)</span>}
                </td>
                <td className={`font-semibold ${totalClass(t.totalMs)}`}>{t.totalMs}</td>
                <td>{cell(t.eotMs)}</td>
                <td>{cell(t.sttMs)}</td>
                <td>{cell(t.llmFirstTokenMs)}</td>
                <td>{cell(t.ttsFirstAudioMs)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
