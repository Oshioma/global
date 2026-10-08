// Scheduled polling entrypoint: scans every source whose polling schedule is
// due, then deletes unpublished events that have already finished.
//
// Vercel Cron (see vercel.json) calls this with GET and the CRON_SECRET
// bearer token, so GET and POST both run the job. An external scheduler works
// just as well:
//
//   */30 * * * *  curl -s -X POST https://guestlist.net/api/jobs/scan-sources \
//                   -H "Authorization: Bearer $SUPPLY_CRON_SECRET"
//
// Auth: either bearer secret, or an admin session for manual runs.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getCurrentMember } from '@/lib/auth';
import { scanDueSources } from '@/lib/supply/scanner';
import { purgeFinishedUnpublished } from '@/lib/adminEvents';
import { resolveDuplicates } from '@/lib/duplicates';
import { ensurePendingSources } from '@/lib/supply/suggest';

export const maxDuration = 300;

function matches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// SUPPLY_CRON_SECRET is ours; CRON_SECRET is the one Vercel Cron sends.
function secretMatches(header: string | null): boolean {
  return matches(header, process.env.SUPPLY_CRON_SECRET) || matches(header, process.env.CRON_SECRET);
}

async function run(req: NextRequest) {
  if (!secretMatches(req.headers.get('authorization'))) {
    const member = await getCurrentMember();
    if (member?.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }
  }
  // A monthly suggestion with no source yet gets one, so this run can scan it.
  await ensurePendingSources();
  const { scanned, results } = await scanDueSources();
  // Housekeeping on the same schedule: anything left in New or Needs Review
  // after it finished is deleted, so the review queues only hold events
  // somebody could still go to.
  const purgedFinished = await purgeFinishedUnpublished();
  // And settle what this run flagged as possible duplicates.
  const duplicates = await resolveDuplicates();
  return NextResponse.json({
    ok: true,
    scanned,
    purgedFinished,
    duplicates,
    results: results.map((r) => ({
      scanId: r.scanId, status: r.status, method: r.method,
      candidates: r.candidatesFound, new: r.newCandidates,
      extracted: r.extracted, failed: r.failed, duplicates: r.duplicates,
    })),
  });
}

export const POST = run;
export const GET = run;
