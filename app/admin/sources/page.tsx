// ADMIN → EVENTS → SOURCES: the independent event graph. Each source can be
// scanned on demand (SCAN NOW) or polled on a schedule via the
// /api/jobs/scan-sources cron endpoint. Trust levels gate auto-publishing.
//
// Sources are organised by COUNTRY (one section per country, not one flat
// list) and can be filtered by country, and by genre.
//
// Two tabs: the WORKBENCH is where sources are found, added, tested and
// fixed; LIVE & POLLING holds the ones that already work, so the bench stays
// a short list of things that still need attention.

import Link from 'next/link';
import { query } from '@/lib/db';
import { fmtDate, sourceTypeLabel } from '@/lib/util';
import { AddSourceForm } from '@/components/admin/AddSourceForm';
import { SourceDiscovery } from '@/components/admin/SourceDiscovery';
import { SourceSuggestions, type SuggestionRow } from '@/components/admin/SourceSuggestions';
import { monthKey } from '@/lib/supply/suggest';
import { SourceControls } from '@/components/admin/SourceControls';
import { isLiveSource } from '@/lib/supply/health';
import { canonicalCountry } from '@/lib/countries';

export const dynamic = 'force-dynamic';

type SourceRow = {
  id: string;
  source_type: string;
  name: string;
  url: string;
  feed_url: string | null;
  active: boolean;
  trust: string;
  polling_enabled: boolean;
  render_js: boolean;
  max_candidates: number | null;
  poll_frequency_hours: number;
  last_checked_at: string | null;
  last_success_at: string | null;
  events_found: number;
  failure_count: number;
  city: string | null;
  country: string | null;
  genre_ids: string[];
  genre_names: string[];
  genre_slugs: string[];
  promoter_name: string | null;
  venue_name: string | null;
  linked_events: number;
  scan_count: number;
  last_scan_new: number | null;
  last_scan_extracted: number | null;
};

const NO_COUNTRY = 'No country yet';

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ country?: string; genre?: string; view?: string }>;
}) {
  const params = await searchParams;
  const countryFilter = params.country?.trim() || null;
  const genreFilter = params.genre?.trim() || null;
  const view = params.view === 'live' ? 'live' : 'workbench';

  const sources = await query<SourceRow>(
    `select s.id, s.source_type, s.name, s.url, s.feed_url, s.active, s.trust,
            s.polling_enabled, s.poll_frequency_hours, s.render_js, s.max_candidates,
            s.last_checked_at::text, s.last_success_at::text,
            s.events_found, s.failure_count, s.city, s.country,
            coalesce(sg.genre_ids, '{}') as genre_ids,
            coalesce(sg.genre_names, '{}') as genre_names,
            coalesce(sg.genre_slugs, '{}') as genre_slugs,
            p.name as promoter_name, v.name as venue_name,
            (select count(*)::int from event_source_links l where l.source_id = s.id) as linked_events,
            coalesce(sc.scan_count, 0) as scan_count,
            sc.last_scan_new, sc.last_scan_extracted
       from event_sources s
       left join promoters p on p.id = s.promoter_id
       left join venues v on v.id = s.venue_id
       left join lateral (
         select array_agg(g.id::text order by g.name) as genre_ids,
                array_agg(g.name order by g.name) as genre_names,
                array_agg(g.slug order by g.name) as genre_slugs
           from event_source_genres esg
           join genres g on g.id = esg.genre_id
          where esg.source_id = s.id
       ) sg on true
       left join lateral (
         select count(*)::int as scan_count,
                (select new_candidates from source_scans x
                  where x.source_id = s.id order by started_at desc limit 1) as last_scan_new,
                (select extracted from source_scans x
                  where x.source_id = s.id order by started_at desc limit 1) as last_scan_extracted
           from source_scans sc2 where sc2.source_id = s.id
       ) sc on true
      order by s.active desc, s.name`
  );

  const [promoters, venues, genres, knownCountries] = await Promise.all([
    query<{ id: string; name: string }>(`select id, name from promoters order by name`),
    query<{ id: string; name: string }>(`select id, name from venues order by name`),
    query<{ id: string; name: string; slug: string; parent_genre_id: string | null }>(
      `select id, name, slug, parent_genre_id from genres where active
        order by (parent_genre_id is not null), sort_order, name`
    ),
    query<{ country: string }>(
      `select distinct country from (
         select country from event_sources where country is not null
         union select country_name from locations where country_name is not null
       ) c(country) order by country`
    ),
  ]);

  // The monthly suggestions: everything still waiting on a decision, plus
  // what this month already decided. A deployment that has not run migration
  // 045 yet simply has none, rather than a broken page.
  const month = monthKey();
  const [suggestions, extraCountries] = await Promise.all([
    query<SuggestionRow>(
      `select id, batch_month, genre_key, name, url, kind, city, country, note,
              candidates, verdict, status, source_id
         from source_suggestions
        where status = 'pending' or batch_month = $1
        order by (status = 'pending') desc, created_at desc`,
      [month]
    ).catch(() => [] as SuggestionRow[]),
    query<{ country: string }>(
      `select country from source_suggestion_countries order by country`
    ).catch(() => [] as { country: string }[]),
  ]);
  const sourceCountries = [...new Set(
    sources.map((s) => canonicalCountry(s.country)).filter((c): c is string => !!c)
  )];

  // The bench and the live list are two different jobs, so each tab counts
  // and filters only its own sources.
  const liveSources = sources.filter(isLiveSource);
  const benchSources = sources.filter((s) => !isLiveSource(s));
  const inView = view === 'live' ? liveSources : benchSources;

  // Country chips carry counts from the FULL set of the current tab, so the
  // filter bar stays stable while a filter is applied.
  const countryCounts = new Map<string, number>();
  for (const s of inView) {
    const key = canonicalCountry(s.country) || NO_COUNTRY;
    countryCounts.set(key, (countryCounts.get(key) ?? 0) + 1);
  }
  const countryChips = [...countryCounts.entries()].sort((a, b) =>
    a[0] === NO_COUNTRY ? 1 : b[0] === NO_COUNTRY ? -1 : a[0].localeCompare(b[0]));

  const genreCounts = new Map<string, { name: string; count: number }>();
  for (const s of inView) {
    s.genre_slugs.forEach((slug, i) => {
      const cur = genreCounts.get(slug);
      genreCounts.set(slug, { name: s.genre_names[i], count: (cur?.count ?? 0) + 1 });
    });
  }
  const genreChips = [...genreCounts.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name));

  const filtered = inView.filter((s) => {
    const country = canonicalCountry(s.country) || NO_COUNTRY;
    if (countryFilter && country !== countryFilter) return false;
    if (genreFilter && !s.genre_slugs.includes(genreFilter)) return false;
    return true;
  });

  // One section per country; unassigned sources go last so they read as the
  // to-tag pile, not the front page.
  const groups = new Map<string, SourceRow[]>();
  for (const s of filtered) {
    const key = canonicalCountry(s.country) || NO_COUNTRY;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(s);
  }
  const orderedGroups = [...groups.entries()].sort((a, b) =>
    a[0] === NO_COUNTRY ? 1 : b[0] === NO_COUNTRY ? -1 : a[0].localeCompare(b[0]));
  for (const [, rows] of orderedGroups) {
    rows.sort((a, b) =>
      (a.city ?? '￿').localeCompare(b.city ?? '￿') || a.name.localeCompare(b.name));
  }

  const filterHref = (next: { country?: string | null; genre?: string | null; view?: string }) => {
    const q = new URLSearchParams();
    const c = next.country === undefined ? countryFilter : next.country;
    const g = next.genre === undefined ? genreFilter : next.genre;
    const v = next.view === undefined ? view : next.view;
    if (c) q.set('country', c);
    if (g) q.set('genre', g);
    if (v === 'live') q.set('view', 'live');
    const s = q.toString();
    return s ? `/admin/sources?${s}` : '/admin/sources';
  };

  return (
    <main>
      <h1 className="adminTitle">Sources</h1>
      <p className="adminSub">
        The independent event graph: promoter sites, venue calendars, festivals,
        labels, feeds and blogs we monitor directly — no dependency on the big
        ticket platforms. TRUSTED sources qualify for conservative auto-publishing.
        Organised by country — tag each source with a city, country and genres.
      </p>

      <div className="statePills">
        <Link className={`statePill${view === 'workbench' ? ' active' : ''}`}
              href={filterHref({ view: 'workbench' })}>
          Workbench <span className="n">{benchSources.length}</span>
        </Link>
        <Link className={`statePill${view === 'live' ? ' active' : ''}`}
              href={filterHref({ view: 'live' })}>
          Live &amp; polling <span className="n">{liveSources.length}</span>
        </Link>
      </div>

      <p className="adminSub" style={{ marginTop: -12 }}>
        {view === 'workbench'
          ? 'Sources being added, tested and fixed — new, paused, failing, or polling without finding anything yet.'
          : 'Switched on, polling on a schedule, no failures, and producing events. Nothing here needs you today.'}
      </p>

      {view === 'workbench' && (
        <>
          <SourceSuggestions
            month={month}
            suggestions={suggestions}
            extraCountries={extraCountries.map((c) => c.country)}
            sourceCountries={sourceCountries}
          />
          <SourceDiscovery
            genres={genres}
            countries={knownCountries.map((c) => c.country)}
          />
          <AddSourceForm
            promoters={promoters}
            venues={venues}
            genres={genres}
            countries={knownCountries.map((c) => c.country)}
          />
        </>
      )}

      <div className="chipRow" style={{ marginBottom: 8 }}>
        <Link className={`chip${!countryFilter ? ' active' : ''}`} href={filterHref({ country: null })}>
          All countries ({inView.length})
        </Link>
        {countryChips.map(([country, count]) => (
          <Link
            key={country}
            className={`chip${countryFilter === country ? ' active' : ''}`}
            href={filterHref({ country: countryFilter === country ? null : country })}
          >
            {country} ({count})
          </Link>
        ))}
      </div>
      {genreChips.length > 0 && (
        <div className="chipRow" style={{ marginBottom: 18 }}>
          <Link className={`chip${!genreFilter ? ' active' : ''}`} href={filterHref({ genre: null })}>
            All genres
          </Link>
          {genreChips.map(([slug, g]) => (
            <Link
              key={slug}
              className={`chip${genreFilter === slug ? ' active' : ''}`}
              href={filterHref({ genre: genreFilter === slug ? null : slug })}
            >
              {g.name} ({g.count})
            </Link>
          ))}
        </div>
      )}

      {orderedGroups.map(([country, rows]) => (
        <section key={country} style={{ marginBottom: 30 }}>
          <h2 style={{ fontSize: 15, letterSpacing: '.08em', textTransform: 'uppercase', margin: '18px 0 10px' }}>
            {country}{' '}
            <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>
              · {rows.length} source{rows.length === 1 ? '' : 's'}
            </span>
          </h2>
          <div className="adminTableWrap">
            <table className="adminTable">
              <thead>
                <tr>
                  <th>Source name</th>
                  <th>City</th>
                  <th>Genres</th>
                  <th>Type</th>
                  <th>URL</th>
                  <th>Trust</th>
                  <th>Events found</th>
                  <th>Last checked</th>
                  <th>Status / controls</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((s) => (
                  <tr key={s.id}>
                    <td>
                      <strong>{s.name}</strong>
                      {(s.promoter_name || s.venue_name) && (
                        <div style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                          {s.promoter_name ?? s.venue_name}
                        </div>
                      )}
                    </td>
                    <td>{s.city ?? <span style={{ color: 'var(--text-faint)' }}>—</span>}</td>
                    <td style={{ maxWidth: 160 }}>
                      {s.genre_names.length
                        ? <span style={{ fontSize: 12 }}>{s.genre_names.join(', ')}</span>
                        : <span style={{ color: 'var(--text-faint)' }}>—</span>}
                    </td>
                    <td>{sourceTypeLabel(s.source_type)}</td>
                    <td>
                      <a href={s.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'underline' }}>
                        {new URL(s.url).hostname}
                      </a>
                      {s.feed_url && (
                        <div style={{ color: 'var(--text-faint)', fontSize: 11 }} title={s.feed_url}>RSS ✓</div>
                      )}
                    </td>
                    <td><span className={`trustPill ${s.trust}`}>{s.trust}</span></td>
                    <td>
                      {s.events_found || s.linked_events || 0}
                      {s.scan_count > 0 && s.last_scan_new != null && (
                        <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                          last scan: {s.last_scan_new} new, {s.last_scan_extracted} extracted
                        </div>
                      )}
                    </td>
                    <td>
                      {s.last_checked_at
                        ? fmtDate(s.last_checked_at, 'Europe/London', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })
                        : 'Never'}
                      {s.failure_count > 0 && (
                        <div style={{ color: 'var(--danger)', fontSize: 12 }}>{s.failure_count} failures</div>
                      )}
                    </td>
                    <td>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6, fontSize: 12.5 }}>
                        <span className={`statusDot ${s.active ? 'ok' : 'off'}`} />
                        {s.active ? (s.polling_enabled ? `Polling ${s.poll_frequency_hours}h` : 'Active') : 'Paused'}
                      </div>
                      <SourceControls
                        id={s.id}
                        name={s.name}
                        url={s.url}
                        feedUrl={s.feed_url}
                        active={s.active}
                        trust={s.trust}
                        pollingEnabled={s.polling_enabled}
                        renderJs={s.render_js}
                        maxCandidates={s.max_candidates}
                        pollFrequencyHours={s.poll_frequency_hours}
                        city={s.city}
                        country={s.country}
                        genreIds={s.genre_ids}
                        genres={genres}
                        countries={knownCountries.map((c) => c.country)}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}
      {filtered.length === 0 && (
        <p style={{ color: 'var(--text-faint)' }}>
          {inView.length > 0
            ? 'No sources match these filters.'
            : view === 'live'
              ? 'Nothing is live yet — a source moves here once it is polling without failures and has found events.'
              : sources.length === 0
                ? 'No sources yet. Search a country above to find some.'
                : 'Everything is live and polling. Nothing on the bench.'}
        </p>
      )}
    </main>
  );
}
