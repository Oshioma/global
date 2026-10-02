// The member event-alert engine.
//
//   EVENT PUBLISHED → relevant members → preferences → privacy/blocks →
//   relevance strength → dedupe/frequency → ONE notification → allowed
//   channel (in-app always; email only when strong + instant + under cap).
//
// One event matching five of a member's signals produces ONE notification
// carrying every reason, priority-ordered. Weak signals (genre/city alone)
// never trigger instant email — they land in-app and in the daily digest.
// Every queue operation is idempotent: publish hooks and cron jobs can run
// twice without a duplicate notification or email.

import { query, queryOne } from './db';
import { track } from './analytics';
import {
  eventBlocks, isoWeek, queueEmail, queueMemberWeeklyDigest, renderEmailHtml, unsubscribeUrl,
} from './email';
import { getSafetySwitches } from './settings';
import { getRecommendedEvents } from './recommend';
import { fmtEventDate, fmtEventTime } from './util';

const SITE = process.env.SITE_URL ?? 'https://www.guestlist.net';

// Deterministic reason priority — the first reason a member sees.
export const ALERT_REASON_PRIORITY = [
  'TRAVEL_MATCH',
  'FOLLOWED_PROMOTER',
  'FOLLOWED_ARTIST',
  'CLOSE_FRIEND_GOING', // stronger than an ordinary connection, by design
  'CONNECTION_GOING',
  'FOLLOWED_VENUE',
  'HOME_CITY',
  'FOLLOWED_CITY',
  'GENRE_MATCH',
] as const;
export type AlertReasonCode = (typeof ALERT_REASON_PRIORITY)[number];

// Strong = high-intent → eligible for instant email. Weak = digest/in-app.
export const STRONG_REASONS: ReadonlySet<string> = new Set([
  'TRAVEL_MATCH', 'FOLLOWED_PROMOTER', 'FOLLOWED_ARTIST', 'CLOSE_FRIEND_GOING',
  'CONNECTION_GOING', 'FOLLOWED_VENUE',
]);

export type AlertReason = { code: AlertReasonCode; detail?: string };

export function sortReasons(reasons: AlertReason[]): AlertReason[] {
  return [...reasons].sort(
    (a, b) => ALERT_REASON_PRIORITY.indexOf(a.code) - ALERT_REASON_PRIORITY.indexOf(b.code)
  );
}

export function alertReasonText(r: AlertReason): string {
  switch (r.code) {
    case 'CLOSE_FRIEND_GOING': return r.detail ? `★ ${r.detail} is going` : '★ A close friend is going';
    case 'TRAVEL_MATCH': return r.detail ? `During your ${r.detail} trip` : 'During your trip';
    case 'FOLLOWED_PROMOTER': return r.detail ? `Because you follow ${r.detail}` : 'From a promoter you follow';
    case 'FOLLOWED_ARTIST': return r.detail ? `${r.detail} is playing` : 'An artist you follow is playing';
    case 'CONNECTION_GOING': return r.detail ? `${r.detail} is going` : 'A connection is going';
    case 'FOLLOWED_VENUE': return r.detail ? `At ${r.detail}, which you follow` : 'At a venue you follow';
    case 'HOME_CITY': return r.detail ? `In ${r.detail}, matching your music` : 'Near you, matching your music';
    case 'FOLLOWED_CITY': return r.detail ? `New in ${r.detail}` : 'In a city you follow';
    case 'GENRE_MATCH': return r.detail ? `Because you like ${r.detail}` : 'Matches your music';
  }
}

// ---------------------------------------------------------------------------
// EVENT PUBLISHED — the main entry point. Safe to call repeatedly (dedupe
// index makes re-publishing a no-op) and never throws into its caller.
// ---------------------------------------------------------------------------

export async function onEventPublished(eventId: string): Promise<{ notified: number; emailed: number }> {
  try {
    return await evaluateEventForAlerts(eventId);
  } catch (err) {
    console.error('alert evaluation failed', err);
    return { notified: 0, emailed: 0 };
  }
}

async function evaluateEventForAlerts(eventId: string): Promise<{ notified: number; emailed: number }> {
  const event = await queryOne<{
    id: string; title: string; slug: string; start_at: string; end_at: string | null;
    timezone: string; city: string | null; location_id: string | null;
    promoter_id: string | null; promoter_name: string | null; venue_id: string | null;
    venue_name: string | null;
  }>(
    `select e.id, e.title, e.slug, e.start_at::text, e.end_at::text, e.timezone, e.city,
            e.location_id, e.promoter_id, p.name as promoter_name, e.venue_id, v.name as venue_name
       from events e
       left join promoters p on p.id = e.promoter_id
       left join venues v on v.id = e.venue_id
      where e.id = $1 and e.status = 'live'
        and e.listing_status <> 'cancelled' and e.start_at > now()`,
    [eventId]
  );
  if (!event) return { notified: 0, emailed: 0 };

  // One pass: every member with at least one signal for this event, with
  // per-signal flags. Preferences gate each signal; blocks are irrelevant
  // here (events are public), but club-suspension and dead accounts aren't
  // targeted.
  const candidates = await query<{
    id: string; email: string; alert_frequency: string;
    followed_promoter: boolean; followed_artists: string[]; followed_venue: boolean;
    travel_city: string | null; home_city_genre: string | null; followed_city_genre: string | null;
  }>(
    `select m.id, m.email,
            coalesce(p.alert_frequency, 'daily') as alert_frequency,
            (coalesce(p.followed_promoter_events, true) and $2::uuid is not null and exists (
              select 1 from member_follows f where f.member_id = m.id
                and f.entity_type = 'promoter' and f.entity_id = $2)) as followed_promoter,
            coalesce((select json_agg(a.name)
               from member_follows f
               join event_artists ea on ea.artist_id = f.entity_id and ea.event_id = $1
               join artists a on a.id = f.entity_id
              where f.member_id = m.id and f.entity_type = 'artist'
                and coalesce(p.followed_artist_events, true)), '[]'::json) as followed_artists,
            (coalesce(p.followed_venue_events, true) and $3::uuid is not null and exists (
              select 1 from member_follows f where f.member_id = m.id
                and f.entity_type = 'venue' and f.entity_id = $3)) as followed_venue,
            (select l.name from travel_plans tp join locations l on l.id = tp.location_id
              where coalesce(p.travel_events, true) and tp.member_id = m.id
                and $4::uuid is not null and tp.location_id = $4
                and $5::date between tp.start_date and tp.end_date
              limit 1) as travel_city,
            (select g.name from member_genres mg
               join event_genres eg on eg.genre_id = mg.genre_id and eg.event_id = $1
               join genres g on g.id = mg.genre_id
              where coalesce(p.genre_in_home_city, false) and mg.member_id = m.id
                and $4::uuid is not null and m.home_location_id = $4
              limit 1) as home_city_genre,
            (select g.name from member_genres mg
               join event_genres eg on eg.genre_id = mg.genre_id and eg.event_id = $1
               join genres g on g.id = mg.genre_id
               join member_locations ml on ml.member_id = m.id and ml.location_id = $4
              where coalesce(p.genre_in_home_city, false) and mg.member_id = m.id
                and $4::uuid is not null
                and (m.home_location_id is null or m.home_location_id <> $4)
              limit 1) as followed_city_genre
       from members m
       left join member_email_prefs p on p.member_id = m.id
      where coalesce(p.alert_frequency, 'daily') <> 'off'
        and not exists (select 1 from event_feedback ef
                         where ef.member_id = m.id and ef.event_id = $1)`,
    [eventId, event.promoter_id, event.venue_id, event.location_id,
     event.start_at.slice(0, 10)]
  );

  const switches = await getSafetySwitches();
  let notified = 0;
  let emailed = 0;

  for (const c of candidates) {
    const reasons: AlertReason[] = [];
    if (c.travel_city) reasons.push({ code: 'TRAVEL_MATCH', detail: c.travel_city });
    if (c.followed_promoter && event.promoter_name) {
      reasons.push({ code: 'FOLLOWED_PROMOTER', detail: event.promoter_name });
    }
    if (c.followed_artists.length) {
      reasons.push({ code: 'FOLLOWED_ARTIST', detail: c.followed_artists[0] });
    }
    if (c.followed_venue && event.venue_name) {
      reasons.push({ code: 'FOLLOWED_VENUE', detail: event.venue_name });
    }
    if (c.home_city_genre && event.city) {
      reasons.push({ code: 'HOME_CITY', detail: event.city });
      reasons.push({ code: 'GENRE_MATCH', detail: c.home_city_genre });
    } else if (c.followed_city_genre && event.city) {
      reasons.push({ code: 'FOLLOWED_CITY', detail: event.city });
      reasons.push({ code: 'GENRE_MATCH', detail: c.followed_city_genre });
    }
    if (!reasons.length) continue;

    const sorted = sortReasons(reasons);
    // ONE notification per member per event — the unique index enforces it.
    const inserted = await queryOne<{ id: string }>(
      `insert into notifications (member_id, type, event_id, promoter_id, payload)
       values ($1, 'event_alert', $2, $3, $4)
       on conflict do nothing
       returning id`,
      [c.id, eventId, event.promoter_id,
       JSON.stringify({ reasons: sorted, title: event.title, slug: event.slug })]
    );
    if (!inserted) continue; // already alerted for this event
    notified++;
    await track('alert_created', {
      memberId: c.id, eventId,
      metadata: { reasons: sorted.map((r) => r.code) },
    });

    // Instant email: strong reason + instant preference + not paused;
    // queueEmail applies the daily cap + suppression on top.
    const strong = sorted.some((r) => STRONG_REASONS.has(r.code));
    if (strong && c.alert_frequency === 'instant' && !switches.pause_recommendation_emails) {
      const top = sorted[0];
      const { outcome } = await queueEmail({
        recipientEmail: c.email,
        memberId: c.id,
        emailType: 'alert:event',
        subject: `${event.title} — ${alertReasonText(top)}`,
        bodyText: [
          event.title,
          `${fmtEventDate(event.start_at, event.end_at, event.timezone)}${event.city ? ` · ${event.city}` : ''}`,
          sorted.map(alertReasonText).join(' · '),
          '',
          `${SITE}/events/${event.slug}?src=email-alert`,
          `Stop these: ${unsubscribeUrl(c.id, 'alerts')}`,
        ].join('\n'),
        bodyHtml: renderEmailHtml({
          heading: event.title,
          intro: sorted.map(alertReasonText).join(' · '),
          events: [{
            title: event.title,
            meta: [fmtEventDate(event.start_at, event.end_at, event.timezone),
                   event.venue_name, event.city].filter(Boolean).join(' · '),
            reason: alertReasonText(top),
            url: `${SITE}/events/${event.slug}?src=email-alert`,
          }],
          cta: { label: 'VIEW EVENT', url: `${SITE}/events/${event.slug}?src=email-alert` },
          memberId: c.id,
          emailType: 'alert:event',
        }),
        dedupeKey: `alert:${c.id}:${eventId}`,
      });
      if (outcome === 'queued') {
        emailed++;
        await query(`update notifications set emailed_at = now() where id = $1`, [inserted.id]);
      }
    }
  }
  return { notified, emailed };
}

// ---------------------------------------------------------------------------
// CONNECTION GOING — fired from the RSVP route. Only where there is real
// relevance: the connection saved/RSVP'd the same event or follows its
// promoter. Actor privacy (show_going) is respected; blocks are already
// impossible between connected members.
// ---------------------------------------------------------------------------

export async function onMemberGoing(actorId: string, eventId: string): Promise<number> {
  try {
    const actor = await queryOne<{ display_name: string; visible: boolean }>(
      `select m.display_name,
              coalesce((select mp.show_going and mp.profile_public
                          from member_privacy mp where mp.member_id = m.id), true) as visible
         from members m where m.id = $1`,
      [actorId]
    );
    if (!actor?.visible) return 0;
    const event = await queryOne<{ title: string; slug: string; promoter_id: string | null }>(
      `select title, slug, promoter_id from events
        where id = $1 and status = 'live' and listing_status <> 'cancelled' and start_at > now()`,
      [eventId]
    );
    if (!event) return 0;

    // is_close is DIRECTIONAL: the TARGET privately marked the actor as a
    // close friend. Close friends get wider relevance (a taste-genre match
    // counts) and their own notification type + preference; ordinary
    // connections keep the saved/RSVP'd/followed-promoter requirement.
    const targets = await query<{
      id: string; email: string; wants_email: boolean; alert_frequency: string;
      is_close: boolean; cf_pref: string;
    }>(
      `select m.id, m.email,
              coalesce(p.connection_going, false) as wants_email,
              coalesce(p.alert_frequency, 'daily') as alert_frequency,
              case when c.requester_id = m.id then c.requester_close else c.addressee_close end as is_close,
              coalesce(p.close_friend_activity, 'on') as cf_pref
         from member_connections c
         join members m on m.id = case when c.requester_id = $1 then c.addressee_id else c.requester_id end
         left join member_email_prefs p on p.member_id = m.id
        where c.status = 'connected' and (c.requester_id = $1 or c.addressee_id = $1)
          and (
            exists (select 1 from member_event_actions mea
                     where mea.member_id = m.id and mea.event_id = $2
                       and (mea.saved_at is not null or mea.rsvp is not null))
            or ($3::uuid is not null and exists (
                 select 1 from member_follows f where f.member_id = m.id
                   and f.entity_type = 'promoter' and f.entity_id = $3))
            or (
              -- close friends only: a taste match is enough relevance
              (case when c.requester_id = m.id then c.requester_close else c.addressee_close end)
              and exists (select 1 from member_genres mg
                           join event_genres eg on eg.genre_id = mg.genre_id and eg.event_id = $2
                          where mg.member_id = m.id)
            )
          )`,
      [actorId, eventId, event.promoter_id]
    );

    let created = 0;
    for (const t of targets) {
      const close = t.is_close && t.cf_pref !== 'off';
      if (t.is_close && t.cf_pref === 'off') continue; // their choice is final
      const type = close ? 'close_friend_going' : 'connection_going';
      const inserted = await queryOne<{ id: string }>(
        `insert into notifications (member_id, type, actor_member_id, event_id, payload)
         values ($1, $5, $2, $3, $4)
         on conflict do nothing returning id`,
        [t.id, actorId, eventId,
         JSON.stringify({ actor_name: actor.display_name, title: event.title, slug: event.slug,
                          ...(close ? { close_friend: true } : {}) }),
         type]
      );
      if (!inserted) continue;
      created++;
      await track('alert_created', {
        memberId: t.id, eventId,
        metadata: { reasons: [close ? 'CLOSE_FRIEND_GOING' : 'CONNECTION_GOING'] },
      });
      // Instant email: close friends need only their own pref ON + instant
      // frequency; ordinary connections also need the connection_going
      // email opt-in. 'digest' close friends never get instant email —
      // their notification rides the daily digest instead.
      const emailNow = close
        ? t.cf_pref === 'on' && t.alert_frequency === 'instant'
        : t.wants_email && t.alert_frequency === 'instant';
      if (emailNow) {
        const star = close ? '★ ' : '';
        const { outcome } = await queueEmail({
          recipientEmail: t.email,
          memberId: t.id,
          emailType: close ? 'alert:close_friend' : 'alert:connection',
          subject: `${star}${actor.display_name} is going to ${event.title}`,
          bodyText: `${actor.display_name} is going to ${event.title}.\n\n${SITE}/events/${event.slug}?src=email-connection`,
          bodyHtml: renderEmailHtml({
            heading: `${star}${actor.display_name} is going`,
            intro: event.title,
            cta: { label: 'VIEW EVENT', url: `${SITE}/events/${event.slug}?src=email-connection` },
            memberId: t.id,
            emailType: close ? 'alert:close_friend' : 'alert:connection',
          }),
          dedupeKey: `conn:${t.id}:${actorId}:${eventId}`,
        });
        if (outcome === 'queued') {
          await query(`update notifications set emailed_at = now() where id = $1`, [inserted.id]);
        }
      }
    }
    return created;
  } catch (err) {
    console.error('connection-going alert failed', err);
    return 0;
  }
}

// ---------------------------------------------------------------------------
// TIMEZONE-AWARE SCHEDULING — a member's local time comes from their home
// location's IANA timezone; UTC is the explicit fallback (never a silent
// server-timezone guess).
// ---------------------------------------------------------------------------

export function memberLocalParts(now: Date, timezone: string | null): { hour: number; weekday: string; date: string } {
  const tz = timezone ?? 'UTC';
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour: 'numeric', hour12: false, weekday: 'short',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]));
    return {
      hour: Number(parts.hour) % 24,
      weekday: parts.weekday,
      date: `${parts.year}-${parts.month}-${parts.day}`,
    };
  } catch {
    return memberLocalParts(now, 'UTC');
  }
}

const DIGEST_HOURS = { from: 8, to: 11 } as const; // member-local morning
const WEEKLY_DIGEST_DAY = 'Thu'; // in time for the weekend

// Daily digest: un-emailed alert notifications collapse into ONE email per
// member per local day. This is the digest fallback — five moderate alerts
// become one useful email. Idempotent per member per local date.
export async function runDailyAlertDigests(now = new Date()): Promise<number> {
  const switches = await getSafetySwitches();
  if (switches.pause_recommendation_emails) return 0;

  const members = await query<{
    id: string; email: string; timezone: string | null; alert_frequency: string;
  }>(
    `select distinct m.id, m.email, l.timezone,
            coalesce(p.alert_frequency, 'daily') as alert_frequency
       from notifications n
       join members m on m.id = n.member_id
       left join locations l on l.id = m.home_location_id
       left join member_email_prefs p on p.member_id = m.id
      where n.type in ('event_alert', 'connection_going', 'close_friend_going')
        and n.emailed_at is null and n.read_at is null
        and n.created_at > now() - interval '48 hours'
        and coalesce(p.alert_frequency, 'daily') in ('daily', 'instant')`
  );

  let sent = 0;
  for (const m of members) {
    const local = memberLocalParts(now, m.timezone);
    if (local.hour < DIGEST_HOURS.from || local.hour > DIGEST_HOURS.to) continue;

    const items = await query<{
      id: string; type: string; payload: { reasons?: AlertReason[]; actor_name?: string; title?: string; slug?: string };
      event_title: string | null; event_slug: string | null;
      start_at: string | null; end_at: string | null; timezone: string | null; city: string | null;
    }>(
      `select n.id, n.type, n.payload, e.title as event_title, e.slug as event_slug,
              e.start_at::text, e.end_at::text, e.timezone, e.city
         from notifications n
         left join events e on e.id = n.event_id
        where n.member_id = $1 and n.type in ('event_alert', 'connection_going', 'close_friend_going')
          and n.emailed_at is null and n.read_at is null
          and n.created_at > now() - interval '48 hours'
        order by n.created_at limit 6`,
      [m.id]
    );
    if (!items.length) continue;

    const blocks = items
      .filter((i) => i.event_title && i.event_slug)
      .map((i) => ({
        title: i.type === 'close_friend_going' && i.payload.actor_name
          ? `★ ${i.payload.actor_name} is going: ${i.event_title}`
          : i.type === 'connection_going' && i.payload.actor_name
            ? `${i.payload.actor_name} is going: ${i.event_title}`
            : i.event_title!,
        meta: [i.start_at ? fmtEventDate(i.start_at, i.end_at, i.timezone ?? 'UTC') : null, i.city]
          .filter(Boolean).join(' · '),
        reason: i.payload.reasons?.[0] ? alertReasonText(i.payload.reasons[0]) : null,
        url: `${SITE}/events/${i.event_slug}?src=email-daily`,
      }));
    if (!blocks.length) continue;

    const { outcome } = await queueEmail({
      recipientEmail: m.email,
      memberId: m.id,
      emailType: 'daily_digest',
      subject: `${blocks.length} new event${blocks.length === 1 ? '' : 's'} for you`,
      bodyText: blocks.map((b) => `• ${b.title}\n  ${b.meta}${b.reason ? `\n  ${b.reason}` : ''}\n  ${b.url}`).join('\n\n'),
      bodyHtml: renderEmailHtml({
        heading: `${blocks.length} new event${blocks.length === 1 ? '' : 's'} for you`,
        events: blocks,
        cta: { label: 'SEE EVERYTHING', url: `${SITE}/events` },
        memberId: m.id,
        emailType: 'daily_digest',
      }),
      dedupeKey: `daily-digest:${m.id}:${local.date}`,
    });
    if (outcome === 'queued') {
      sent++;
      await query(
        `update notifications set emailed_at = now()
          where member_id = $1 and id = any($2)`,
        [m.id, items.map((i) => i.id)]
      );
    }
  }
  return sent;
}

// Weekly member digests, member-local Thursday morning. Idempotent per ISO
// week (the dedupe key inside queueMemberWeeklyDigest).
export async function runWeeklyDigests(now = new Date()): Promise<number> {
  const switches = await getSafetySwitches();
  if (switches.pause_recommendation_emails) return 0;
  const members = await query<{ id: string; timezone: string | null }>(
    `select m.id, l.timezone from members m
       left join locations l on l.id = m.home_location_id
      where not exists (select 1 from member_email_prefs p
                         where p.member_id = m.id and not p.weekly_digest)`
  );
  let sent = 0;
  for (const m of members) {
    const local = memberLocalParts(now, m.timezone);
    if (local.weekday !== WEEKLY_DIGEST_DAY) continue;
    if (local.hour < DIGEST_HOURS.from || local.hour > DIGEST_HOURS.to) continue;
    if (await queueMemberWeeklyDigest(m.id)) sent++;
  }
  return sent;
}

// ---------------------------------------------------------------------------
// EVENT REMINDERS — you're Going, it's tomorrow. One reminder per member
// per event, ever (dedupe index); disableable globally per member.
//
// "Tomorrow" means the next calendar day in the event's own timezone, not
// "18–42 hours away": a Saturday 01:00 start is 42 hours from Thursday
// morning, and Thursday is not the day before Saturday. Sent from the
// event-local morning so nobody gets it at midnight.
// ---------------------------------------------------------------------------

const REMINDER_FROM_HOUR = 9; // event-local

export function isReminderDue(now: Date, startAt: string | Date, timezone: string | null): boolean {
  const local = memberLocalParts(now, timezone);
  if (local.hour < REMINDER_FROM_HOUR) return false;
  const tomorrow = memberLocalParts(new Date(now.getTime() + 24 * 3600 * 1000), timezone).date;
  return memberLocalParts(new Date(startAt), timezone).date === tomorrow;
}

export async function queueEventReminders(now = new Date()): Promise<number> {
  const switches = await getSafetySwitches();
  if (switches.pause_event_reminders) return 0;
  const rows = await query<{
    member_id: string; email: string; event_id: string; title: string; slug: string;
    start_at: string; end_at: string | null; timezone: string; venue_name: string | null; city: string | null;
  }>(
    `select mea.member_id, m.email, e.id as event_id, e.title, e.slug,
            e.start_at::text, e.end_at::text, e.timezone, v.name as venue_name, e.city
       from member_event_actions mea
       join events e on e.id = mea.event_id
       join members m on m.id = mea.member_id
       left join venues v on v.id = e.venue_id
       left join member_email_prefs p on p.member_id = mea.member_id
      where mea.rsvp = 'going'
        and e.status = 'live' and e.listing_status <> 'cancelled'
        and e.start_at between now() and now() + interval '48 hours'
        and coalesce(p.event_reminders, true)`
  );
  let created = 0;
  for (const r of rows) {
    if (!isReminderDue(now, r.start_at, r.timezone)) continue;
    const inserted = await queryOne<{ id: string }>(
      `insert into notifications (member_id, type, event_id, payload)
       values ($1, 'event_reminder', $2, $3)
       on conflict do nothing returning id`,
      [r.member_id, r.event_id, JSON.stringify({ title: r.title, slug: r.slug })]
    );
    if (!inserted) continue;
    created++;
    const when = `${fmtEventDate(r.start_at, null, r.timezone)} · ${fmtEventTime(r.start_at, r.end_at, r.timezone)}`;
    const { outcome } = await queueEmail({
      recipientEmail: r.email,
      memberId: r.member_id,
      emailType: 'event_reminder',
      subject: `Tomorrow: ${r.title}`,
      bodyText: [`Tomorrow: ${r.title}`, when,
        [r.venue_name, r.city].filter(Boolean).join(' · '),
        '', `${SITE}/events/${r.slug}?src=email-reminder`].join('\n'),
      bodyHtml: renderEmailHtml({
        heading: `Tomorrow: ${r.title}`,
        intro: [when, [r.venue_name, r.city].filter(Boolean).join(' · ')].filter(Boolean).join(' — '),
        cta: { label: 'VIEW EVENT', url: `${SITE}/events/${r.slug}?src=email-reminder` },
        memberId: r.member_id,
        emailType: 'event_reminder',
      }),
      dedupeKey: `reminder:${r.member_id}:${r.event_id}`,
    });
    if (outcome === 'queued') {
      await query(`update notifications set emailed_at = now() where id = $1`, [inserted.id]);
    }
  }
  return created;
}

// ---------------------------------------------------------------------------
// TRAVEL DIGEST — "we found N events for your Ibiza trip". Runs when a plan
// is 1–14 days out; uses the recommendation service; private dates stay
// private (the email goes only to the traveller). Idempotent per plan.
// ---------------------------------------------------------------------------

export async function queueTravelDigests(): Promise<number> {
  const switches = await getSafetySwitches();
  if (switches.pause_recommendation_emails) return 0;
  const plans = await query<{
    id: string; member_id: string; email: string; location_id: string;
    city: string; start_date: string; end_date: string;
  }>(
    `select tp.id, tp.member_id, m.email, tp.location_id, l.name as city,
            tp.start_date::text, tp.end_date::text
       from travel_plans tp
       join members m on m.id = tp.member_id
       join locations l on l.id = tp.location_id
       left join member_email_prefs p on p.member_id = tp.member_id
      where tp.start_date between current_date and current_date + 14
        and coalesce(p.travel_events, true)
        and coalesce(p.alert_frequency, 'daily') <> 'off'`
  );
  let sent = 0;
  for (const plan of plans) {
    const recs = await getRecommendedEvents(plan.member_id, {
      locationId: plan.location_id,
      from: new Date(`${plan.start_date}T00:00:00Z`),
      to: new Date(`${plan.end_date}T23:59:59Z`),
      limit: 6,
      exploration: false,
    });
    if (recs.length < 2) continue; // only when there's genuinely something there
    const { outcome } = await queueEmail({
      recipientEmail: plan.email,
      memberId: plan.member_id,
      emailType: 'travel_digest',
      subject: `While you're in ${plan.city} — ${recs.length} events for you`,
      bodyText: recs.map((r) =>
        `• ${r.title}\n  ${fmtEventDate(r.start_at, r.end_at, r.timezone)}\n  ${SITE}/events/${r.slug}?src=email-travel`
      ).join('\n\n'),
      bodyHtml: renderEmailHtml({
        heading: `While you're in ${plan.city}`,
        intro: `${recs.length} events during your trip, picked for you.`,
        events: eventBlocks(recs, 'email-travel'),
        cta: { label: `SEE ${plan.city.toUpperCase()}`, url: `${SITE}/events` },
        memberId: plan.member_id,
        emailType: 'travel_digest',
      }),
      dedupeKey: `travel:${plan.id}`,
    });
    if (outcome === 'queued') {
      sent++;
      await query(
        `insert into notifications (member_id, type, payload)
         values ($1, 'travel_digest', $2)`,
        [plan.member_id, JSON.stringify({ city: plan.city, count: recs.length, plan_id: plan.id })]
      );
    }
  }
  return sent;
}

// Promoter review nudge: team members whose queue has events waiting.
export async function queuePromoterReviewNotifications(): Promise<number> {
  const rows = await query<{ promoter_id: string; member_id: string; waiting: number }>(
    `select e.promoter_id, pm.member_id, count(distinct e.id)::int as waiting
       from events e
       join promoter_members pm on pm.promoter_id = e.promoter_id and pm.role in ('owner', 'admin', 'editor')
      where e.status = 'needs_review' and e.promoter_id is not null
      group by e.promoter_id, pm.member_id`
  );
  let created = 0;
  for (const r of rows) {
    const exists = await queryOne(
      `select 1 from notifications
        where member_id = $1 and type = 'promoter_review' and promoter_id = $2
          and created_at > now() - interval '3 days'`,
      [r.member_id, r.promoter_id]
    );
    if (exists) continue;
    await query(
      `insert into notifications (member_id, type, promoter_id, payload)
       values ($1, 'promoter_review', $2, $3)`,
      [r.member_id, r.promoter_id, JSON.stringify({ waiting: r.waiting })]
    );
    created++;
  }
  return created;
}
