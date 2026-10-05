// Monthly source suggestions: five drum & bass, five house and five hip hop
// promoters or clubs that are not sources yet, tested and waiting on
// /admin/sources. See lib/supply/suggest.ts.
//
// Scheduled from Supabase pg_cron (DEPLOYMENT.md) on days 1–7 of each month.
// Each run only tops the month's batch up to five per genre, so the later
// runs are cheap no-ops once it is full, and a run that ran out of time is
// finished by the next one.
//
// Auth: either bearer secret, or an admin session for the "Find more now"
// button.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getCurrentMember } from '@/lib/auth';
import { runMonthlySuggestions } from '@/lib/supply/suggest';

export const maxDuration = 300;

function matches(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header?.startsWith('Bearer ')) return false;
  const provided = Buffer.from(header.slice(7));
  const expected = Buffer.from(secret);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

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
  try {
    return NextResponse.json({ ok: true, ...(await runMonthlySuggestions()) });
  } catch (err) {
    console.error(err);
    return NextResponse.json({ error: 'Suggestion run failed' }, { status: 500 });
  }
}

export const POST = run;
export const GET = run;
