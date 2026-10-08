// SETTLING POSSIBLE DUPLICATES.
//
// The supply pipeline flags an incoming event as a "possible duplicate" of
// one we already have when the two look alike (lib/supply/dedupe.ts). Left to
// a person, those flags piled up in Needs Review. This settles each one with a
// plain rule:
//
//   SAME EVENT  = same place  (the same venue — or, when either has no venue,
//                              the same city)
//               + same date   (the local calendar day, in each event's own
//                              timezone)
//               + similar name (most of the words in common, or one name
//                              wholly inside the other)
//
// The name test is not decoration. A club runs several rooms on one night, and
// their titles share the venue's own name — "Karaoke Room - Sala Razzmatazz"
// and "Perreo Room - Sala Razzmatazz" are two events, not one. Place and date
// alone would merge them.
//
// When it IS the same event, one copy is kept and the other folded into it:
//   - a copy that is already live is always the one kept (its link, its saves
//     and its alerts already exist), and its gaps are filled from the other;
//   - otherwise the copy with more information is kept, and likewise filled.
// When it is NOT the same event, the flag is cleared and it is an ordinary
// event again, free to be published.
//
// Only events waiting for review (New / Needs Review) are ever folded away. A
// rejected event is a decision someone made and is left exactly as it is.

import { query, queryOne } from './db';
import { audit } from './audit';
import { normalizeTitle } from './util';

export type DupEvent = {
  id: string;
  status: string;
  title: string;
  title_normalized: string | null;
  start_at: string | Date;
  timezone: string | null;
  venue_id: string | null;
  city: string | null;
  // Richness inputs.
  short_description: string | null;
  description: string | null;
  primary_image_url: string | null;
  ticket_url: string | null;
  price_from: string | number | null;
  end_at: string | Date | null;
  promoter_id: string | null;
  genre_count: number;
  artist_count: number;
};

const SIMILAR_TITLE = 0.75;

function words(t: string): Set<string> {
  return new Set(t.split(' ').filter(Boolean));
}

// Most of the words in common, or one name wholly inside the other (a
// truncated title, or "… - Waiting List" tacked on the end).
export function titlesMatch(a: string, b: string): boolean {
  const na = normalizeTitle(a);
  const nb = normalizeTitle(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const wa = words(na);
  const wb = words(nb);
  const inter = [...wa].filter((w) => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  if (union && inter / union >= SIMILAR_TITLE) return true;
  const [small, big] = wa.size <= wb.size ? [wa, wb] : [wb, wa];
  return small.size >= 2 && [...small].every((w) => big.has(w));
}

export function localDay(at: string | Date, timezone: string | null): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
}

export function samePlace(a: DupEvent, b: DupEvent): boolean {
  if (a.venue_id && b.venue_id) return a.venue_id === b.venue_id;
  const ca = (a.city ?? '').trim().toLowerCase();
  const cb = (b.city ?? '').trim().toLowerCase();
  return !!ca && ca === cb;
}

export function sameEvent(a: DupEvent, b: DupEvent): boolean {
  return samePlace(a, b)
    && localDay(a.start_at, a.timezone) === localDay(b.start_at, b.timezone)
    && titlesMatch(a.title, b.title);
}

// How much an event tells a member: one point per filled detail, plus its
// genres and its lineup.
export function richness(e: DupEvent): number {
  const filled = [
    e.description, e.short_description, e.primary_image_url, e.ticket_url,
    e.price_from, e.end_at, e.venue_id, e.promoter_id,
  ].filter((v) => v !== null && v !== undefined && v !== '').length;
  return filled + Math.min(e.genre_count, 5) + Math.min(e.artist_count, 10);
}

// Which copy stays. Live always wins; otherwise the richer one, and on a tie
// the one that was here first.
export function pickKeeper(flagged: DupEvent, original: DupEvent): { keep: DupEvent; drop: DupEvent } {
  if (original.status === 'live') return { keep: original, drop: flagged };
  if (flagged.status === 'live') return { keep: flagged, drop: original };
  return richness(flagged) > richness(original)
    ? { keep: flagged, drop: original }
    : { keep: original, drop: flagged };
}

const EVENT_FIELDS = `e.id, e.status::text as status, e.title, e.title_normalized, e.start_at, e.timezone,
  e.venue_id, e.city, e.short_description, e.description, e.primary_image_url, e.ticket_url,
  e.price_from, e.end_at, e.promoter_id,
  (select count(*)::int from event_genres g where g.event_id = e.id) as genre_count,
  (select count(*)::int from event_artists a where a.event_id = e.id) as artist_count`;

const REVIEWABLE = new Set(['new', 'needs_review']);

// Fold `drop` into `keep`: every gap in `keep` that `drop` can fill is filled,
// its genres, lineup and source links move across, and `drop` is deleted.
async function fold(keep: DupEvent, drop: DupEvent) {
  await query(
    `update events k set
        short_description = coalesce(k.short_description, d.short_description),
        description       = coalesce(k.description, d.description),
        primary_image_url = coalesce(k.primary_image_url, d.primary_image_url),
        ticket_url        = coalesce(k.ticket_url, d.ticket_url),
        price_from        = coalesce(k.price_from, d.price_from),
        price_to          = coalesce(k.price_to, d.price_to),
        currency          = coalesce(k.currency, d.currency),
        end_at            = coalesce(k.end_at, d.end_at),
        venue_id          = coalesce(k.venue_id, d.venue_id),
        promoter_id       = coalesce(k.promoter_id, d.promoter_id),
        canonical_url     = coalesce(k.canonical_url, d.canonical_url),
        latitude          = coalesce(k.latitude, d.latitude),
        longitude         = coalesce(k.longitude, d.longitude),
        possible_duplicate_of = case when k.possible_duplicate_of = d.id then null
                                     else k.possible_duplicate_of end,
        updated_at        = now()
       from events d
      where k.id = $1 and d.id = $2`,
    [keep.id, drop.id]
  );
  await query(
    `insert into event_genres (event_id, genre_id, source, confidence)
     select $1, genre_id, source, confidence from event_genres where event_id = $2
     on conflict do nothing`,
    [keep.id, drop.id]
  );
  await query(
    `insert into event_artists (event_id, artist_id, position, billing)
     select $1, artist_id, position, billing from event_artists where event_id = $2
     on conflict do nothing`,
    [keep.id, drop.id]
  );
  // Every place the dropped copy was found now points at the kept one, so a
  // source that lists it keeps finding the event we kept.
  await query(
    `insert into event_source_links (event_id, source_id, extraction_id, url, kind, created_at)
     select $1, source_id, extraction_id, url, kind, created_at from event_source_links where event_id = $2
     on conflict (event_id, url) do nothing`,
    [keep.id, drop.id]
  );
  await query(`update extractions set event_id = $1 where event_id = $2`, [keep.id, drop.id]);
  // Anything else that was pointing at the dropped copy as its original.
  await query(
    `update events set possible_duplicate_of = $1 where possible_duplicate_of = $2 and id <> $1`,
    [keep.id, drop.id]
  );
  await query(`delete from events where id = $1`, [drop.id]);
}

export type ResolveResult = { merged: number; cleared: number };

// Settle every flagged event still waiting for review.
export async function resolveDuplicates(actorId: string | null = null): Promise<ResolveResult> {
  const flagged = await query<{ id: string; original: string }>(
    `select id, possible_duplicate_of as original from events
      where possible_duplicate_of is not null and status in ('new', 'needs_review')
      order by created_at`
  );
  let merged = 0;
  let cleared = 0;
  for (const f of flagged) {
    const [a, b] = await Promise.all([
      queryOne<DupEvent>(`select ${EVENT_FIELDS} from events e where e.id = $1`, [f.id]),
      queryOne<DupEvent>(`select ${EVENT_FIELDS} from events e where e.id = $1`, [f.original]),
    ]);
    // Already folded away earlier in this run, or its original is gone.
    if (!a || !REVIEWABLE.has(a.status)) continue;
    if (!b || b.status === 'rejected' || !sameEvent(a, b)) {
      await query(`update events set possible_duplicate_of = null, updated_at = now() where id = $1`, [a.id]);
      cleared++;
      continue;
    }
    const { keep, drop } = pickKeeper(a, b);
    // Never fold away a published event, whatever the counts say.
    if (!REVIEWABLE.has(drop.status)) {
      await query(`update events set possible_duplicate_of = null, updated_at = now() where id = $1`, [a.id]);
      cleared++;
      continue;
    }
    await fold(keep, drop);
    merged++;
  }
  if (merged || cleared) {
    await audit('duplicates_resolved', { actorId, detail: { merged, cleared } });
  }
  return { merged, cleared };
}
