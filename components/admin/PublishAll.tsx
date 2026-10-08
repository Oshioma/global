'use client';

// PUBLISH ALL — at the top of the review queue, where the decision is made.
//
// It says what it will do before it does it, and what it left behind after:
// duplicates are merged rather than published twice, and events that have
// already finished are cleared out of the queues rather than published.

import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Result = {
  published: number;
  skippedDuplicates: number;
  purgedPast: number;
  mergedDuplicates?: number;
  remaining: number;
  error?: string;
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function PublishAll({ state, count }: { state: 'new' | 'needs_review'; count: number }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);

  async function run() {
    setBusy(true);
    try {
      const res = await fetch('/api/admin/events/publish-all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
      });
      const data = await res.json();
      setResult(res.ok ? data : { published: 0, skippedDuplicates: 0, purgedPast: 0, remaining: 0, error: data.error ?? 'Could not publish' });
      if (res.ok) router.refresh();
    } catch {
      setResult({ published: 0, skippedDuplicates: 0, purgedPast: 0, remaining: 0, error: 'Could not publish' });
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  const notes = result
    ? [
        result.remaining > 0 ? `${plural(result.remaining, 'more')} to go — press again.` : null,
        result.skippedDuplicates > 0
          ? `${plural(result.skippedDuplicates, 'possible duplicate')} left for you to decide.`
          : null,
        result.purgedPast > 0 ? `Cleared out ${plural(result.purgedPast, 'event')} that had already finished.` : null,
        (result.mergedDuplicates ?? 0) > 0
          ? `Merged ${plural(result.mergedDuplicates ?? 0, 'duplicate')} into the copy with more information.`
          : null,
      ].filter(Boolean)
    : [];

  return (
    <div className="publishAllBar">
      <div className="publishAllText">
        <strong>{plural(count, 'event')} waiting</strong>
        <span>
          Publishing them all merges duplicates (same place, date and name — the copy with more
          information is kept), publishes everything else, and clears out anything that has
          already finished.
        </span>
        {result && !result.error && (
          <span className="publishAllDone">
            {`Published ${plural(result.published, 'event')}. ${notes.join(' ')}`}
          </span>
        )}
        {result?.error && <span className="publishAllError">{result.error}</span>}
      </div>
      {confirming ? (
        <div className="publishAllActions">
          <button className="btnAccent" onClick={run} disabled={busy}>
            {busy ? 'Publishing…' : `Yes, publish ${count === 1 ? 'it' : 'them'}`}
          </button>
          <button className="btnGhost" onClick={() => setConfirming(false)} disabled={busy}>
            Cancel
          </button>
        </div>
      ) : (
        <button className="btnAccent" onClick={() => setConfirming(true)} disabled={busy || count === 0}>
          Publish all →
        </button>
      )}
    </div>
  );
}
