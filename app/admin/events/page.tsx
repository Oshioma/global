import Link from 'next/link';
import { query } from '@/lib/db';
import { heldForSuggestionSql } from '@/lib/adminEvents';
import { ReviewCard, type AdminEventRow } from '@/components/admin/ReviewCard';
import { PublishAll } from '@/components/admin/PublishAll';
import { FindImages } from '@/components/admin/FindImages';
import { EventSearch } from '@/components/EventSearch';

export const dynamic = 'force-dynamic';

const STATES = [
  { key: 'new', label: 'New' },
  { key: 'needs_review', label: 'Needs Review' },
  { key: 'live', label: 'Live' },
  { key: 'rejected', label: 'Rejected' },
  { key: 'past', label: 'Past' },
] as const;

export default async function AdminEventsPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const state = STATES.some((s) => s.key === sp.state) ? sp.state! : 'new';
  const q = (sp.q ?? '').trim().slice(0, 120);

  // "Past" is derived (live + finished); the stored states exclude finished
  // events from LIVE so the working queues stay clean.
  const FINISHED_E = `coalesce(e.end_at, e.start_at + interval '6 hours') <= now()`;
  const pastCond = `e.status = 'live' and ${FINISHED_E}`;
  const cond =
    state === 'past'
      ? pastCond
      : state === 'live'
        ? `e.status = 'live' and coalesce(e.end_at, e.start_at + interval '6 hours') > now()`
        // A review queue only holds what is still to come: an unpublished
        // event that has finished is deleted (purgeFinishedUnpublished), and
        // until that runs it is not worth a reviewer's look.
        : state === 'new' || state === 'needs_review'
          ? `e.status = '${state}' and not (${FINISHED_E}) and not ${heldForSuggestionSql('e')}`
          : `e.status = '${state}'`;

  const [events, counts] = await Promise.all([
    query<AdminEventRow>(
      `select e.id, e.title, e.slug, e.start_at, e.end_at, e.timezone, e.city, e.country,
              e.event_type, e.ticket_url, e.price_from, e.price_to, e.currency,
              e.primary_image_url, e.source_url, e.source_type, e.status,
              e.confidence_score, e.featured, e.possible_duplicate_of,
              v.name as venue_name, p.name as promoter_name,
              dup.title as duplicate_of_title, dup.slug as duplicate_of_slug,
              coalesce(gj.genres, '[]'::json) as genres,
              coalesce(lu.lineup, '[]'::json) as lineup,
              ex.field_confidence, ex.field_sources, ex.warnings as extraction_warnings,
              ex.duplicate_state, ex.duplicate_score, ex.ai_used, ex.structured_data_found,
              coalesce(sl.source_count, 0) as source_count,
              coalesce(sl.source_names, '[]'::json) as source_names
         from events e
         left join venues v on v.id = e.venue_id
         left join promoters p on p.id = e.promoter_id
         left join events dup on dup.id = e.possible_duplicate_of
         left join lateral (
           select json_agg(g.name order by g.sort_order) as genres
             from event_genres eg join genres g on g.id = eg.genre_id where eg.event_id = e.id
         ) gj on true
         left join lateral (
           select json_agg(a.name order by ea.position) as lineup
             from event_artists ea join artists a on a.id = ea.artist_id where ea.event_id = e.id
         ) lu on true
         left join lateral (
           select x.field_confidence, x.field_sources, x.warnings,
                  x.duplicate_state, x.duplicate_score, x.ai_used, x.structured_data_found
             from extractions x where x.event_id = e.id
            order by x.created_at desc limit 1
         ) ex on true
         left join lateral (
           select count(*)::int as source_count,
                  json_agg(distinct s.name) filter (where s.name is not null) as source_names
             from event_source_links l
             left join event_sources s on s.id = l.source_id
            where l.event_id = e.id
         ) sl on true
        where ${cond}${q ? ` and (
                e.title ilike $1 escape '\\'
                or e.city ilike $1 escape '\\'
                or e.slug ilike $1 escape '\\'
                or v.name ilike $1 escape '\\'
                or p.name ilike $1 escape '\\'
              )` : ''}
        order by e.created_at desc
        limit 200`,
      // Two hundred rows a queue means the one you are looking for is on a
      // page you have to scroll. The same fields as the public search, plus
      // the slug, because an admin often arrives holding a URL.
      q ? [`%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`] : []
    ),
    query<{ status: string; n: number; past: number }>(
      `select e.status::text, count(*)::int as n,
              count(*) filter (where ${FINISHED_E}
                 or (e.status in ('new', 'needs_review') and ${heldForSuggestionSql('e')}))::int as past
         from events e group by e.status`
    ),
  ]);

  const countFor = (key: string) => {
    if (key === 'past') return counts.find((c) => c.status === 'live')?.past ?? 0;
    const row = counts.find((c) => c.status === key);
    if (!row) return 0;
    return key === 'live' || key === 'new' || key === 'needs_review' ? row.n - row.past : row.n;
  };

  return (
    <main>
      <h1 className="adminTitle">Events</h1>
      <p className="adminSub">
        Review incoming events, publish the good ones, keep the graph clean.
      </p>

      <div className="statePills">
        {STATES.map((s) => (
          <Link
            key={s.key}
            href={`/admin/events?state=${s.key}${q ? `&q=${encodeURIComponent(q)}` : ''}`}
            className={`statePill${state === s.key ? ' active' : ''}`}
          >
            {s.label}
            <span className="n">{countFor(s.key)}</span>
          </Link>
        ))}
      </div>

      <EventSearch initial={q} placeholder="Search this queue — name, slug, venue, promoter, city…" />

      {(state === 'new' || state === 'needs_review') && events.length > 0 && (
        <PublishAll state={state} count={events.length} />
      )}

      {(state === 'new' || state === 'needs_review' || state === 'live') && (
        <FindImages
          state={state}
          missing={events.filter((e) => !e.primary_image_url && e.source_url).length}
        />
      )}

      {events.length === 0 ? (
        <p className="adminSub">{q ? `Nothing in this queue matches “${q}”.` : 'Nothing in this queue.'}</p>
      ) : (
        events.map((e) => <ReviewCard key={e.id} event={e} />)
      )}
    </main>
  );
}
