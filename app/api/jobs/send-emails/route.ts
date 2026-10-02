// Retention cron — run HOURLY. Each stage is idempotent (dedupe keys +
// unique notification indexes), so running twice never double-sends:
//
//   0 * * * *  curl -X POST .../api/jobs/send-emails \
//                -H "Authorization: Bearer $SUPPLY_CRON_SECRET"
//
// Stages: promoter notification bridge → promoter review nudges → event
// reminders → travel digests → daily alert digests (member-local morning)
// → weekly digests (member-local Thursday morning) → promoter weekly
// digests (Mondays UTC) → queue delivery with retries.

import { NextRequest, NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { getCurrentMember } from '@/lib/auth';
import { query } from '@/lib/db';
import {
  processEmailQueue, queuePromoterNotificationEmails, queuePromoterWeeklyDigest, isoWeek,
} from '@/lib/email';
import {
  queueEventReminders, queueTravelDigests, runDailyAlertDigests, runWeeklyDigests,
  queuePromoterReviewNotifications,
} from '@/lib/alerts';
import { getSafetySwitches } from '@/lib/settings';
import { processAnnouncements } from '@/lib/announcements';
import { refreshAdminReviewDigest } from '@/lib/adminNotify';
import { queueVerificationNudges } from '@/lib/emailVerification';

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
  const now = new Date();
  const switches = await getSafetySwitches();

  // What is waiting on an admin, refreshed hourly. The per-happening hooks
  // keep it live during the day; this is the safety net for anything that
  // reached a queue by another route.
  const adminDigests = await refreshAdminReviewDigest();

  // Somebody who joined a day ago and never confirmed is invisible and does
  // not know it. One reminder, ever — the dedupe key enforces that, so this
  // running hourly cannot turn into nagging.
  const verifyNudges = await queueVerificationNudges();

  const notificationEmails = await queuePromoterNotificationEmails();
  const promoterReview = await queuePromoterReviewNotifications();
  const reminders = await queueEventReminders(now);
  const travelDigests = await queueTravelDigests();
  const dailyDigests = await runDailyAlertDigests(now);
  const weeklyDigests = await runWeeklyDigests(now);

  // Promoter weekly digests: Mondays, once per ISO week per promoter
  // (dedupe key inside), unless paused.
  let promoterDigests = 0;
  if (!switches.pause_promoter_digests && now.getUTCDay() === 1) {
    const promoters = await query<{ id: string }>(
      `select distinct p.id from promoters p
         join promoter_members pm on pm.promoter_id = p.id
        where p.claim_status = 'verified'`
    );
    for (const p of promoters) {
      if (await queuePromoterWeeklyDigest(p.id)) promoterDigests++;
    }
  }
  // Manual/testing override: ?digest=weekly forces both digest passes
  // regardless of day and timezone (still idempotent per ISO week).
  let memberDigests = 0;
  if (req.nextUrl.searchParams.get('digest') === 'weekly') {
    if (!switches.pause_recommendation_emails) {
      const { queueMemberWeeklyDigest } = await import('@/lib/email');
      const members = await query<{ id: string }>(
        `select m.id from members m
          where not exists (select 1 from member_email_prefs p
                             where p.member_id = m.id and not p.weekly_digest)`
      );
      for (const m of members) {
        if (await queueMemberWeeklyDigest(m.id)) memberDigests++;
      }
    }
    if (!switches.pause_promoter_digests) {
      const promoters = await query<{ id: string }>(
        `select distinct p.id from promoters p
           join promoter_members pm on pm.promoter_id = p.id
          where p.claim_status = 'verified'`
      );
      for (const p of promoters) {
        if (await queuePromoterWeeklyDigest(p.id)) promoterDigests++;
      }
    }
  }

  // Promoter → follower announcements: due queued/scheduled runs, batched
  // and idempotent (per-announcement notification dedupe + email keys).
  const announcements = await processAnnouncements();

  const delivery = await processEmailQueue();
  return NextResponse.json({
    ok: true,
    isoWeek: isoWeek(now),
    announcements,
    verifyNudges,
    notificationEmails, promoterReview, reminders, travelDigests,
    dailyDigests, weeklyDigests, memberDigests, promoterDigests, adminDigests,
    ...delivery,
  });
}

// Vercel Cron sends GET; an external scheduler can keep using POST.
export const POST = run;
export const GET = run;
