// Start a scan and wait for its result, for the panels that offer "Scan now"
// on a source they have just added.
//
// POST /api/admin/sources/[id]/scan only STARTS the job and answers with its
// id; the scan itself runs afterwards. Reading that first answer as the
// result is what made every scan from these panels say "Scan failed" while
// the events were quietly arriving. Browser-only: nothing here touches the
// server's modules.

import type { OutcomeTally } from './outcomes';

export type WatchedScan = {
  status: string; extracted: number; candidatesFound: number;
  newCandidates: number; duplicates: number; failed: number; error: string | null;
  couldPoll: boolean; outcomes: OutcomeTally; note?: string | null;
};

const WATCH_EVERY_MS = 2_000;
const WATCH_FOR_MS = 6 * 60_000;

export async function startAndWatchScan(
  sourceId: string,
  onProgress?: (note: string | null) => void
): Promise<{ ok: true; scan: WatchedScan } | { ok: false; error: string }> {
  let scanId: string | undefined;
  try {
    const res = await fetch(`/api/admin/sources/${sourceId}/scan`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: data?.error ?? 'Scan failed' };
    scanId = data.scanId;
  } catch {
    return { ok: false, error: 'Could not reach the server' };
  }
  if (!scanId) return { ok: false, error: 'Scan did not start' };

  const until = Date.now() + WATCH_FOR_MS;
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, WATCH_EVERY_MS));
    const poll = await fetch(`/api/admin/sources/${sourceId}/scan?scanId=${scanId}`).catch(() => null);
    if (!poll?.ok) continue; // a blip is not a verdict
    const scan: WatchedScan & { running: boolean } = await poll.json();
    if (scan.running) { onProgress?.(scan.note ?? null); continue; }
    return { ok: true, scan };
  }
  return { ok: false, error: 'Still running. It keeps going without this page — reload to see how it finished.' };
}
