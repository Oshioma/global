'use client';

// Filter + sort controls for /events.
// Desktop: an inline row of selects. Mobile: a single Filters button opening
// a bottom sheet — deliberately not the desktop row squeezed down.

import { useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { track } from '@/lib/track';
import { genresParam, parseGenres, withCompanions } from '@/lib/genreFilter';

type GenreOpt = { name: string; slug: string; parent_name: string | null };

type Current = {
  genre: string | null;
  type: string | null;
  city: string | null;
  date: string | null;
  price: string | null;
  sort: string;
  nearMe: boolean;
};

const EVENT_TYPE_OPTS: [string, string][] = [
  ['day_party', 'Day Party'], ['club_night', 'Club Night'], ['festival', 'Festival'],
  ['weekender', 'Weekender'], ['boat_party', 'Boat Party'], ['beach_party', 'Beach Party'],
  ['concert', 'Concert / Live'], ['retreat', 'Retreat / Experience'], ['other', 'Other'],
];
const DATE_OPTS: [string, string][] = [
  ['today', 'Today'], ['tomorrow', 'Tomorrow'], ['week', 'Next 7 days'], ['month', 'This month'],
];
const PRICE_OPTS: [string, string][] = [
  ['free', 'Free'], ['20', 'Under £20'], ['50', 'Under £50'], ['100', 'Under £100'],
];
const SORT_OPTS: [string, string][] = [
  ['recommended', 'Recommended'], ['soonest', 'Soonest'],
  ['popular', 'Most Popular'], ['newest', 'Recently Added'],
];

export function FilterControls({
  cities,
  genres,
  current,
}: {
  cities: string[];
  genres: GenreOpt[];
  current: Current;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [locating, setLocating] = useState(false);

  function setParams(updates: Record<string, string | null>) {
    const params = new URLSearchParams(searchParams.toString());
    for (const [k, v] of Object.entries(updates)) {
      if (v) params.set(k, v);
      else params.delete(k);
    }
    if (updates.genre) track('genre_selected', { genreSlug: updates.genre });
    if (updates.city) track('location_selected', { city: updates.city });
    const s = params.toString();
    router.push(s ? `/events?${s}` : '/events');
  }

  function nearMe() {
    if (current.nearMe) {
      setParams({ lat: null, lng: null });
      return;
    }
    if (!navigator.geolocation) return;
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocating(false);
        track('location_selected', { nearMe: true });
        setParams({
          lat: pos.coords.latitude.toFixed(4),
          lng: pos.coords.longitude.toFixed(4),
          city: null,
        });
      },
      () => setLocating(false),
      { timeout: 8000 }
    );
  }

  // The chips can select several genres; this select picks one (bringing its
  // companions, as the chips do). With several on, it says how many.
  const selectedGenres = parseGenres(current.genre);
  const genreValue = selectedGenres.length === 1 ? selectedGenres[0] : '';
  const pickGenre = (slug: string) =>
    setParams({ genre: slug ? genresParam(withCompanions(slug)) : null });
  const genreLabel = (fallback: string) =>
    selectedGenres.length > 1 ? `${selectedGenres.length} genres` : fallback;

  const parents = genres.filter((g) => !g.parent_name);
  const children = genres.filter((g) => g.parent_name);

  const selects = (
    <>
      <select
        value={current.date ?? ''}
        onChange={(e) => setParams({ date: e.target.value || null })}
        className={current.date ? 'isSet' : ''}
        aria-label="Date"
      >
        <option value="">Date</option>
        {DATE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select
        value={current.city ?? ''}
        onChange={(e) => setParams({ city: e.target.value || null, lat: null, lng: null })}
        className={current.city ? 'isSet' : ''}
        aria-label="Location"
      >
        <option value="">Location</option>
        {cities.map((c) => <option key={c} value={c}>{c}</option>)}
      </select>
      <select
        value={genreValue}
        onChange={(e) => pickGenre(e.target.value)}
        className={current.genre ? 'isSet' : ''}
        aria-label="Genre"
      >
        <option value="">{genreLabel('Genre')}</option>
        <optgroup label="Genres">
          {parents.map((g) => <option key={g.slug} value={g.slug}>{g.name}</option>)}
        </optgroup>
        <optgroup label="Subgenres">
          {children.map((g) => (
            <option key={g.slug} value={g.slug}>{g.parent_name} — {g.name}</option>
          ))}
        </optgroup>
      </select>
      <select
        value={current.type ?? ''}
        onChange={(e) => setParams({ type: e.target.value || null })}
        className={current.type ? 'isSet' : ''}
        aria-label="Event type"
      >
        <option value="">Event Type</option>
        {EVENT_TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      <select
        value={current.price ?? ''}
        onChange={(e) => setParams({ price: e.target.value || null })}
        className={current.price ? 'isSet' : ''}
        aria-label="Price"
      >
        <option value="">Price</option>
        {PRICE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
    </>
  );

  return (
    <div className="filterRow">
      <button
        className={`btnGhost${current.nearMe ? ' isActive' : ''}`}
        onClick={nearMe}
        type="button"
      >
        {locating ? 'Locating…' : current.nearMe ? '◉ Near me' : '○ Near me'}
      </button>

      <span className="desktopOnly filterSelects">{selects}</span>

      <button className="btnGhost mobileFilterBtn" onClick={() => setSheetOpen(true)} type="button">
        Filters
        {[current.date, current.city, current.genre, current.type, current.price].filter(Boolean).length > 0 &&
          ` · ${[current.date, current.city, current.genre, current.type, current.price].filter(Boolean).length}`}
      </button>

      <span className="sortSpacer" />
      <select
        value={current.sort}
        onChange={(e) => setParams({ sort: e.target.value === 'recommended' ? null : e.target.value })}
        aria-label="Sort"
      >
        {SORT_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>

      {sheetOpen && (
        <>
          <div className="drawerOverlay" onClick={() => setSheetOpen(false)} />
          <div className="filterSheet" role="dialog" aria-label="Filters">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 18 }}>
              <strong style={{ fontSize: 16, letterSpacing: -0.3 }}>Filters</strong>
              <button className="btnGhost" onClick={() => setSheetOpen(false)} type="button">Done</button>
            </div>
            <div className="field">
              <label>Date</label>
              <select value={current.date ?? ''} onChange={(e) => setParams({ date: e.target.value || null })}>
                <option value="">Any date</option>
                {DATE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Location</label>
              <select value={current.city ?? ''} onChange={(e) => setParams({ city: e.target.value || null, lat: null, lng: null })}>
                <option value="">Anywhere</option>
                {cities.map((c) => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Genre</label>
              <select value={genreValue} onChange={(e) => pickGenre(e.target.value)}>
                <option value="">{genreLabel('All genres')}</option>
                <optgroup label="Genres">
                  {parents.map((g) => <option key={g.slug} value={g.slug}>{g.name}</option>)}
                </optgroup>
                <optgroup label="Subgenres">
                  {children.map((g) => (
                    <option key={g.slug} value={g.slug}>{g.parent_name} — {g.name}</option>
                  ))}
                </optgroup>
              </select>
            </div>
            <div className="field">
              <label>Event type</label>
              <select value={current.type ?? ''} onChange={(e) => setParams({ type: e.target.value || null })}>
                <option value="">All types</option>
                {EVENT_TYPE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <div className="field">
              <label>Price</label>
              <select value={current.price ?? ''} onChange={(e) => setParams({ price: e.target.value || null })}>
                <option value="">Any price</option>
                {PRICE_OPTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </div>
            <button
              className="btnGhost"
              style={{ width: '100%' }}
              onClick={() => setParams({ date: null, city: null, genre: null, type: null, price: null, lat: null, lng: null })}
              type="button"
            >
              Clear all
            </button>
          </div>
        </>
      )}
    </div>
  );
}
