import type { Metadata } from 'next';
import { pageMeta } from '@/lib/seo';
import Link from 'next/link';
import { genresParam, parseGenres, toggleGenre } from '@/lib/genreFilter';
import { getCurrentMember } from '@/lib/auth';
import { isActiveMember } from '@/lib/membership';
import {
  browseEvents, getLiveCities, getTopLevelGenres,
  type BrowseParams, type BrowseTab,
} from '@/lib/events';
import { query } from '@/lib/db';
import { EventCard } from '@/components/EventCard';
import { FilterControls } from '@/components/FilterControls';
import { EventSearch } from '@/components/EventSearch';
import { StickyFilters } from '@/components/StickyFilters';
import { getRecommendedEvents, trackRecommendationImpressions, weekendWindow } from '@/lib/recommend';
import { placeAnchorsFor } from '@/lib/proximity';
import { toRecCards } from '@/lib/recCards';
import { PicksHero } from '@/components/PicksHero';
import { AskPanel } from '@/components/ask/AskPanel';

export const metadata: Metadata = pageMeta({
  title: 'What’s on tonight — club nights and events',
  description: 'Tonight, this weekend and what’s coming up. Club nights, parties and live music, with the people going and the tickets that are left.',
  path: '/events',
});


export const dynamic = 'force-dynamic';

const TABS: { key: BrowseTab; label: string }[] = [
  { key: 'for-you', label: 'For You' },
  { key: 'this-weekend', label: 'This Weekend' },
  { key: 'day-parties', label: 'Day Parties' },
  { key: 'nightlife', label: 'Nightlife' },
  { key: 'festivals', label: 'Festivals' },
  { key: 'travel', label: 'Worth Travelling For' },
];

const INLINE_GENRES = ['house', 'drum-and-bass', 'jungle', 'techno', 'garage', 'disco', 'trance', 'reggae-and-dub'];

function datePresetRange(preset: string | undefined): { from: Date | null; to: Date | null } {
  if (!preset) return { from: null, to: null };
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const plus = (base: Date, days: number) => {
    const d = new Date(base);
    d.setDate(d.getDate() + days);
    return d;
  };
  switch (preset) {
    case 'today': return { from: start, to: plus(start, 1) };
    case 'tomorrow': return { from: plus(start, 1), to: plus(start, 2) };
    case 'week': return { from: start, to: plus(start, 7) };
    case 'month': return { from: start, to: plus(start, 31) };
    default: return { from: null, to: null };
  }
}

type Search = { [key: string]: string | string[] | undefined };
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

export default async function EventsPage({ searchParams }: { searchParams: Promise<Search> }) {
  const sp = await searchParams;
  const member = await getCurrentMember();
  const guestlistMember = member ? await isActiveMember(member.id) : false;

  const tab = (TABS.some((t) => t.key === one(sp.tab)) ? one(sp.tab) : 'for-you') as BrowseTab;
  // One genre or several (?genre=house,jungle) — see lib/genreFilter.
  const selectedGenres = parseGenres(sp.genre);
  const genre = genresParam(selectedGenres);
  const eventType = one(sp.type) || null;
  const city = one(sp.city) || null;
  const datePreset = one(sp.date) || undefined;
  const price = one(sp.price) || null;
  const sortRaw = one(sp.sort);
  const sort = (['recommended', 'soonest', 'popular', 'newest'].includes(sortRaw ?? '')
    ? sortRaw
    : 'recommended') as BrowseParams['sort'];
  const lat = one(sp.lat) ? Number(one(sp.lat)) : null;
  const lng = one(sp.lng) ? Number(one(sp.lng)) : null;
  const showAllGenres = one(sp.more) === '1';
  const q = (one(sp.q) ?? '').trim().slice(0, 120) || null;

  const { from, to } = datePresetRange(datePreset);

  // Where home is, as their PLACE knows it — the profile's country field is
  // empty for anyone who set a city instead, and Worth Travelling For needs
  // to know what "away" means. Nobody we cannot place is at home in the UK
  // (lib/proximity), signed in or not.
  const homeCountry = (await placeAnchorsFor(member?.id)).map((p) => p.country_name).find(Boolean) ?? null;

  const [events, genres, cities] = await Promise.all([
    browseEvents({
      tab,
      genreSlugs: selectedGenres,
      eventType,
      city,
      dateFrom: from,
      dateTo: to,
      freeOnly: price === 'free',
      maxPrice: price && price !== 'free' ? Number(price) : null,
      lat: Number.isFinite(lat as number) ? lat : null,
      lng: Number.isFinite(lng as number) ? lng : null,
      radiusKm: lat != null && lng != null ? 80 : null,
      sort,
      q,
      member: member ? { id: member.id, home_country: member.home_country } : null,
      homeCountry,
    }),
    getTopLevelGenres(),
    getLiveCities(),
  ]);

  // All genres (with parents) for the genre filter select.
  const allGenres = await query<{ name: string; slug: string; parent_name: string | null }>(
    `select g.name, g.slug, pg.name as parent_name
       from genres g left join genres pg on pg.id = g.parent_genre_id
      where g.active order by coalesce(pg.sort_order, g.sort_order), g.parent_genre_id nulls first, g.sort_order`
  );

  // Personalised picks on the unfiltered For You / This Weekend tabs.
  const noFilters = !genre && !eventType && !city && !datePreset && !price;
  let picks: Awaited<ReturnType<typeof getRecommendedEvents>> = [];
  if (member && noFilters && (tab === 'for-you' || tab === 'this-weekend')) {
    const window = tab === 'this-weekend' ? weekendWindow() : { from: null, to: null };
    picks = await getRecommendedEvents(member.id, {
      limit: 8, from: window.from, to: window.to,
    });
    await trackRecommendationImpressions(member.id, picks, `events_${tab}`);
  }

  const savedIds = new Set<string>(
    member
      ? (
          await query<{ event_id: string }>(
            `select event_id from member_event_actions where member_id = $1 and saved_at is not null`,
            [member.id]
          )
        ).map((r) => r.event_id)
      : []
  );

  const buildQS = (overrides: Record<string, string | null>) => {
    const params = new URLSearchParams();
    const current: Record<string, string | null> = {
      tab: tab === 'for-you' ? null : tab,
      genre, type: eventType, city, date: datePreset ?? null, price,
      sort: sort === 'recommended' ? null : sort,
      more: showAllGenres ? '1' : null,
    };
    for (const [k, v] of Object.entries({ ...current, ...overrides })) {
      if (v) params.set(k, v);
    }
    const s = params.toString();
    return s ? `/events?${s}` : '/events';
  };

  const inlineGenres = genres.filter((g) => INLINE_GENRES.includes(g.slug));
  const moreGenres = genres.filter((g) => !INLINE_GENRES.includes(g.slug));
  const visibleGenres = showAllGenres ? [...inlineGenres, ...moreGenres] : inlineGenres;

  return (
    <main className="wrap">
      <h1 className="pageTitle">Events</h1>
      <p className="pageStandfirst">
        Nights, parties, festivals and experiences worth leaving the house for —
        curated for people who were raised on this music.
      </p>

      {picks.length > 0 && (
        <PicksHero
          title={tab === 'this-weekend' ? 'Your weekend, picked' : 'Picks for you'}
          surface={`events_${tab}`}
          events={toRecCards(picks)}
        />
      )}

      {/* Everything that narrows the list, kept together and kept on screen.
          Scrolling past the controls and then having to scroll back to change
          your mind is the whole problem this solves. */}
      <StickyFilters>
        <nav className="tabRow" aria-label="Discovery">
          {TABS.map((t) => (
            <Link
              key={t.key}
              href={buildQS({ tab: t.key === 'for-you' ? null : t.key })}
              className={`tab${tab === t.key ? ' active' : ''}`}
            >
              {t.label}
            </Link>
          ))}
        </nav>

        <div className="chipRow" aria-label="Genres">
          <Link href={buildQS({ genre: null })} className={`chip${!genre ? ' active' : ''}`}>
            All
          </Link>
          {/* Each chip toggles: pick as many as you like. Drum & bass brings
              jungle with it (lib/genreFilter). */}
          {visibleGenres.map((g) => {
            const on = selectedGenres.includes(g.slug);
            return (
              <Link
                key={g.slug}
                href={buildQS({ genre: genresParam(toggleGenre(selectedGenres, g.slug)) })}
                className={`chip${on ? ' active' : ''}`}
                aria-pressed={on}
              >
                {g.name}
              </Link>
            );
          })}
          {!showAllGenres && moreGenres.length > 0 && (
            <Link href={buildQS({ more: '1' })} className="chip">
              More +
            </Link>
          )}
        </div>

        <EventSearch initial={q ?? ''} />

        <FilterControls
          cities={cities.map((c) => c.city)}
          genres={allGenres}
          current={{
            genre, type: eventType, city, date: datePreset ?? null, price, sort,
            nearMe: lat != null && lng != null,
          }}
        />
      </StickyFilters>

      <div className="resultMeta">
        {events.length === 0
          ? null
          : `${events.length} event${events.length === 1 ? '' : 's'}`}
      </div>

      {events.length > 0 ? (
        <div className="cardGrid">
          {events.map((e) => (
            <EventCard key={e.id} event={e} saved={savedIds.has(e.id)} isSignedIn={!!member} />
          ))}
        </div>
      ) : (
        <div className="emptyState">
          <h3>Nothing matching that yet.</h3>
          <p>
            {city && tab !== 'for-you'
              ? `${city} has nights on Guestlist — just none under ${TABS.find((t) => t.key === tab)?.label}.`
              : 'The right night might be one filter away.'}
          </p>
          {/* A member who cannot find it is not a dead end: it is a request.
              Missing inventory becomes demand data. */}
          {guestlistMember && (
            <div className="askEmpty">
              <div className="homeKicker" style={{ marginBottom: 6 }}>Can’t find it?</div>
              <p>Send it to Guestlist. We’ll see if we can get you in.</p>
              <Link href={`/you/ask?context=events_empty${city ? `&city=${encodeURIComponent(city)}` : ''}`} className="btnAccent">Ask Guestlist</Link>
            </div>
          )}
          <div className="suggestions">
            {genre && (
              <Link href={buildQS({ genre: null })} className="btnGhost">Remove genre</Link>
            )}
            {(datePreset || tab === 'this-weekend') && (
              <Link href={buildQS({ date: null, tab: null })} className="btnGhost">Any date</Link>
            )}
            {city && (
              <Link href={buildQS({ city: null })} className="btnGhost">Anywhere</Link>
            )}
            {/* Picking a city from the list and getting nothing is a dead end:
                the city HAS events, this tab just does not have them. Offer
                the city without the tab rather than leaving them to guess. */}
            {city && tab !== 'for-you' && (
              <Link href={buildQS({ tab: null })} className="btnAccent">
                {`See everything in ${city}`}
              </Link>
            )}
            {(eventType || price) && (
              <Link href={buildQS({ type: null, price: null })} className="btnGhost">Clear filters</Link>
            )}
            <Link href={buildQS({ tab: 'travel', genre: null, city: null, date: null })} className="btnGhost">
              Browse destinations
            </Link>
            {/* The most useful answer to "nothing matched" is often that the
                night exists and we have not got it yet. */}
            <Link href="/events/submit/manual" className="btnGhost">Add an event</Link>
          </div>
        </div>
      )}

      {/* Ask sits under the listings: browse what's on first, then ask when
          the list hasn't answered it. */}
      <AskPanel isSignedIn={!!member} isMember={guestlistMember} />

    </main>
  );
}
