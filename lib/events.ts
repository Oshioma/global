// Event queries for discovery, detail and admin surfaces.

import { query, queryOne } from './db';
import { placeAnchorsFor, proximityTierSql, DEFAULT_HOME } from './proximity';

export type GenreTag = { id: string; name: string; slug: string; parent_genre_id: string | null };

export type EventCard = {
  id: string;
  title: string;
  slug: string;
  short_description: string | null;
  start_at: string;
  end_at: string | null;
  timezone: string;
  city: string | null;
  country: string | null;
  event_type: string;
  price_from: string | null;
  price_to: string | null;
  currency: string | null;
  primary_image_url: string | null;
  featured: boolean;
  listing_status: string;
  venue_name: string | null;
  going_count: number;
  interested_count: number;
  genres: { name: string; slug: string }[];
  going_avatars: { display_name: string; avatar_url: string | null }[];
};

// How far from a chosen city still counts as "near" it. Wide enough for the
// places people actually travel to for a night out (Dar es Salaam →
// Zanzibar, London → Brighton), tight enough that another country never
// qualifies by accident.
export { NEAR_KM } from './proximity';

export type BrowseTab =
  | 'for-you'
  | 'this-weekend'
  | 'day-parties'
  | 'nightlife'
  | 'festivals'
  | 'travel';

export type BrowseParams = {
  tab: BrowseTab;
  genreSlug?: string | null;
  // Any of these (each including its subgenres). Combined with genreSlug.
  genreSlugs?: string[];
  eventType?: string | null;
  city?: string | null;
  dateFrom?: Date | null;
  dateTo?: Date | null;
  maxPrice?: number | null;
  freeOnly?: boolean;
  lat?: number | null;
  lng?: number | null;
  radiusKm?: number | null;
  sort: 'recommended' | 'soonest' | 'popular' | 'newest';
  member?: { id: string; home_country: string | null } | null;
  // The member's country as their PLACE knows it, when the text field on
  // their profile is empty. Resolved by the caller so this stays one query.
  homeCountry?: string | null;
  /** Free text: the night's name, its venue, its city, its promoter, its line-up. */
  q?: string | null;
  limit?: number;
};

// Upcoming = not yet finished (events with no end time get a 6h grace window).
const UPCOMING_SQL = `coalesce(e.end_at, e.start_at + interval '6 hours') > now()`;
// Cancelled events stay on their own pages (clearly marked) but leave the
// browse grid; sold out / postponed remain listed with badges.
const LISTABLE_SQL = `e.listing_status <> 'cancelled'`;

function weekendWindow(): { from: Date; to: Date } {
  // Friday 00:00 → Monday 06:00 of the current/next weekend, local server time.
  const now = new Date();
  const day = now.getDay(); // 0 Sun … 6 Sat
  const friOffset = day === 0 ? -2 : 5 - day; // Sun belongs to the current weekend
  const fri = new Date(now);
  fri.setDate(now.getDate() + friOffset);
  fri.setHours(0, 0, 0, 0);
  const mon = new Date(fri);
  mon.setDate(fri.getDate() + 3);
  mon.setHours(6, 0, 0, 0);
  return { from: fri, to: mon };
}

export async function browseEvents(params: BrowseParams): Promise<EventCard[]> {
  const where: string[] = [`e.status = 'live'`, UPCOMING_SQL, LISTABLE_SQL];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };

  switch (params.tab) {
    case 'this-weekend': {
      const { from, to } = weekendWindow();
      // Any overlap with the weekend window (multi-day festivals included).
      where.push(
        `e.start_at < ${arg(to)} and coalesce(e.end_at, e.start_at + interval '6 hours') > ${arg(from)}`
      );
      break;
    }
    case 'day-parties':
      where.push(`e.event_type in ('day_party', 'beach_party', 'boat_party')`);
      break;
    case 'nightlife':
      where.push(`e.event_type = 'club_night'`);
      break;
    case 'festivals':
      where.push(`e.event_type in ('festival', 'weekender')`);
      break;
    case 'travel': {
      // Away from home. Two things were quietly making this tab lie:
      //
      // 1. It read only members.home_country, a free-text field that is empty
      //    for anyone who set their city rather than typing a country — so
      //    the tab fell back to "flagged worth travelling" alone, and a real
      //    Paris night nobody had flagged was invisible.
      // 2. `e.country <> home` drops every event with NO country recorded.
      //    An event whose country we never captured is not thereby at home.
      // Nobody we cannot place is at home in the UK (lib/proximity), so
      // "away" means outside the United Kingdom for them.
      const home = params.member?.home_country ?? params.homeCountry ?? DEFAULT_HOME.country;
      const eventCountry =
        `coalesce(e.country, (select l.country_name from locations l where l.id = e.location_id))`;
      where.push(`(e.worth_travelling or ${eventCountry} is distinct from ${arg(home)})`);
      break;
    }
  }

  const genreSlugs = [...new Set([...(params.genreSlugs ?? []), ...(params.genreSlug ? [params.genreSlug] : [])])];
  if (genreSlugs.length) {
    // ANY of the chosen genres; a parent genre includes all of its subgenres.
    const slugs = arg(genreSlugs);
    where.push(`exists (
      select 1 from event_genres eg
        join genres g on g.id = eg.genre_id
        left join genres pg on pg.id = g.parent_genre_id
       where eg.event_id = e.id and (g.slug = any(${slugs}::text[]) or pg.slug = any(${slugs}::text[]))
    )`);
  }
  if (params.q) {
    // Searching a listings site means "I half-remember something": a name, a
    // room, a DJ. So it looks in all of them at once rather than making
    // somebody choose which field their memory belongs to. ILIKE with a
    // wildcard both ends — a prefix index would not help a search for
    // "warehouse" inside "The Old Warehouse", and these are small tables.
    const like = `%${params.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
    where.push(`(
      e.title ilike ${arg(like)} escape '\\'
      or e.city ilike ${arg(like)} escape '\\'
      or exists (select 1 from venues v2 where v2.id = e.venue_id and v2.name ilike ${arg(like)} escape '\\')
      or exists (select 1 from promoters p2 where p2.id = e.promoter_id and p2.name ilike ${arg(like)} escape '\\')
      or exists (
        select 1 from event_artists ea2 join artists a2 on a2.id = ea2.artist_id
         where ea2.event_id = e.id and a2.name ilike ${arg(like)} escape '\\'
      )
    )`);
  }
  if (params.eventType) where.push(`e.event_type = ${arg(params.eventType)}::event_type`);
  if (params.city) where.push(`lower(e.city) = lower(${arg(params.city)})`);
  if (params.dateFrom) where.push(`coalesce(e.end_at, e.start_at + interval '6 hours') > ${arg(params.dateFrom)}`);
  if (params.dateTo) where.push(`e.start_at < ${arg(params.dateTo)}`);
  if (params.freeOnly) where.push(`e.price_from = 0`);
  else if (params.maxPrice != null) where.push(`(e.price_from is null or e.price_from <= ${arg(params.maxPrice)})`);

  let distanceSelect = 'null::float as distance_km';
  if (params.lat != null && params.lng != null) {
    const latP = arg(params.lat);
    const lngP = arg(params.lng);
    // Haversine, km.
    distanceSelect = `(6371 * acos(least(1, greatest(-1,
        cos(radians(${latP})) * cos(radians(e.latitude)) *
        cos(radians(e.longitude) - radians(${lngP})) +
        sin(radians(${latP})) * sin(radians(e.latitude))
      )))) as distance_km`;
    if (params.radiusKm != null) {
      where.push(`e.latitude is not null and e.longitude is not null and
        (6371 * acos(least(1, greatest(-1,
          cos(radians(${latP})) * cos(radians(e.latitude)) *
          cos(radians(e.longitude) - radians(${lngP})) +
          sin(radians(${latP})) * sin(radians(e.latitude))
        )))) <= ${arg(params.radiusKm)}`);
    }
  }

  // Where a member's life actually is. Events near one of their chosen
  // cities rank above events merely in the same country, which rank above
  // the rest of the world — so someone in London is not shown Ibiza and
  // Zanzibar ahead of what is on this weekend. Distance, not country, is
  // what decides "near": Dar es Salaam picks up Zanzibar (~65km) while
  // London never picks up Spain.
  // Worth Travelling For is *about* leaving home, so it never gets the
  // near-home tier applied to it.
  // Where a member's life actually is — near one of their cities, then their
  // country, then the rest of the world. One definition, shared with the
  // Tonight list (lib/proximity), so the two surfaces cannot disagree about
  // where somebody lives.
  // Worth Travelling For is *about* leaving home, so it never gets the
  // near-home tier applied to it.
  // Anyone we cannot place — signed out, or a member who never set a city —
  // is placed in London (lib/proximity): London first, then the rest of the
  // UK, then the world. A UK guide by default.
  // Both of these only feed the RECOMMENDED order. Built for any other sort,
  // their parameters were bound but never used — and Postgres refuses a query
  // that is handed more parameters than it reads, so Soonest, Most Popular and
  // Recently Added failed outright.
  const recommended = params.sort === 'recommended';
  let proximityTier = '(select 0)';
  if (recommended && params.tab !== 'travel') {
    proximityTier = proximityTierSql(await placeAnchorsFor(params.member?.id), arg);
  }

  // Recommended ranking: near home first, then featured, then follow +
  // explicit-genre affinity for signed-in members (a followed
  // promoter/venue/artist counts double), then soonest.
  let genreAffinity = '(select 0)';
  if (recommended && params.member?.id) {
    const memberParam = arg(params.member.id);
    genreAffinity = `(
      (select count(*) from event_genres eg2
         join member_genres mg on mg.genre_id = eg2.genre_id
        where eg2.event_id = e.id and mg.member_id = ${memberParam})
      + 2 * (select count(*) from member_follows mf
        where mf.member_id = ${memberParam} and (
          (mf.entity_type = 'promoter' and mf.entity_id = e.promoter_id) or
          (mf.entity_type = 'venue' and mf.entity_id = e.venue_id) or
          (mf.entity_type = 'artist' and mf.entity_id in
            (select ea3.artist_id from event_artists ea3 where ea3.event_id = e.id))
        ))
    )`;
  }

  const orderBy = {
    recommended: `${proximityTier} asc, e.featured desc, ${genreAffinity} desc, e.start_at asc`,
    soonest: `e.start_at asc`,
    popular: `(pop.going_count * 2 + pop.interested_count) desc, e.start_at asc`,
    newest: `coalesce(e.published_at, e.created_at) desc`,
  }[params.sort];

  const rows = await query<EventCard & { distance_km: number | null }>(
    `select e.id, e.title, e.slug, e.short_description, e.start_at, e.end_at, e.timezone,
            e.city, e.country, e.event_type, e.price_from, e.price_to, e.currency,
            e.primary_image_url, e.featured, e.listing_status,
            v.name as venue_name,
            pop.going_count, pop.interested_count,
            coalesce(gj.genres, '[]'::json) as genres,
            coalesce(av.going_avatars, '[]'::json) as going_avatars,
            ${distanceSelect}
       from events e
       left join venues v on v.id = e.venue_id
       cross join lateral (
         select count(*) filter (where mea.rsvp = 'going')::int as going_count,
                count(*) filter (where mea.rsvp = 'interested')::int as interested_count
           from member_event_actions mea where mea.event_id = e.id
       ) pop
       left join lateral (
         select json_agg(json_build_object('name', g.name, 'slug', g.slug) order by g.sort_order) as genres
           from event_genres eg join genres g on g.id = eg.genre_id
          where eg.event_id = e.id
       ) gj on true
       left join lateral (
         select json_agg(json_build_object('display_name', m.display_name, 'avatar_url', m.avatar_url)) as going_avatars
           from (
             select m2.display_name, m2.avatar_url
               from member_event_actions mea join members m2 on m2.id = mea.member_id
              where mea.event_id = e.id and mea.rsvp = 'going'
              order by mea.rsvp_at asc limit 4
           ) m
       ) av on true
      where ${where.join(' and ')}
      order by ${orderBy}
      limit ${Math.min(params.limit ?? 60, 120)}`,
    args
  );
  return rows;
}

// Event cards for an entity page (promoter / venue / artist).
export async function eventsForEntity(
  entity: { promoterId?: string; venueId?: string; artistId?: string },
  when: 'upcoming' | 'past',
  limit = 24
): Promise<EventCard[]> {
  const where: string[] = [`e.status = 'live'`];
  const args: unknown[] = [];
  const arg = (v: unknown) => {
    args.push(v);
    return `$${args.length}`;
  };
  if (entity.promoterId) where.push(`e.promoter_id = ${arg(entity.promoterId)}`);
  if (entity.venueId) where.push(`e.venue_id = ${arg(entity.venueId)}`);
  if (entity.artistId) {
    where.push(`exists (select 1 from event_artists ea where ea.event_id = e.id and ea.artist_id = ${arg(entity.artistId)})`);
  }
  if (when === 'upcoming') {
    where.push(UPCOMING_SQL, LISTABLE_SQL);
  } else {
    where.push(`coalesce(e.end_at, e.start_at + interval '6 hours') <= now()`);
  }
  return query<EventCard>(
    `select e.id, e.title, e.slug, e.short_description, e.start_at, e.end_at, e.timezone,
            e.city, e.country, e.event_type, e.price_from, e.price_to, e.currency,
            e.primary_image_url, e.featured, e.listing_status,
            v.name as venue_name,
            pop.going_count, pop.interested_count,
            coalesce(gj.genres, '[]'::json) as genres,
            coalesce(av.going_avatars, '[]'::json) as going_avatars
       from events e
       left join venues v on v.id = e.venue_id
       cross join lateral (
         select count(*) filter (where mea.rsvp = 'going')::int as going_count,
                count(*) filter (where mea.rsvp = 'interested')::int as interested_count
           from member_event_actions mea where mea.event_id = e.id
       ) pop
       left join lateral (
         select json_agg(json_build_object('name', g.name, 'slug', g.slug) order by g.sort_order) as genres
           from event_genres eg join genres g on g.id = eg.genre_id where eg.event_id = e.id
       ) gj on true
       left join lateral (
         select json_agg(json_build_object('display_name', m.display_name, 'avatar_url', m.avatar_url)) as going_avatars
           from (
             select m2.display_name, m2.avatar_url
               from member_event_actions mea join members m2 on m2.id = mea.member_id
              where mea.event_id = e.id and mea.rsvp = 'going'
              order by mea.rsvp_at asc limit 4
           ) m
       ) av on true
      where ${where.join(' and ')}
      order by e.start_at ${when === 'upcoming' ? 'asc' : 'desc'}
      limit ${Math.min(limit, 60)}`,
    args
  );
}

export type EventDetail = EventCard & {
  description: string | null;
  latitude: number | null;
  longitude: number | null;
  ticket_url: string | null;
  source_url: string | null;
  status: string;
  venue: {
    name: string; slug: string; address: string | null; city: string | null;
    country: string | null; latitude: number | null; longitude: number | null; website: string | null;
  } | null;
  promoter: {
    id: string; name: string; slug: string; description: string | null;
    website: string | null; image_url: string | null; verified: boolean;
  } | null;
  lineup: { name: string; slug: string; position: number; billing: string | null }[];
  images: { url: string; alt: string | null }[];
};

export async function getEventBySlug(slug: string, includeUnpublished = false): Promise<EventDetail | null> {
  return queryOne<EventDetail>(
    `select e.*, v.name as venue_name,
            pop.going_count, pop.interested_count,
            coalesce(gj.genres, '[]'::json) as genres,
            coalesce(av.going_avatars, '[]'::json) as going_avatars,
            case when v.id is not null then json_build_object(
              'name', v.name, 'slug', v.slug, 'address', v.address, 'city', v.city,
              'country', v.country, 'latitude', v.latitude, 'longitude', v.longitude,
              'website', v.website) end as venue,
            case when p.id is not null then json_build_object(
              'id', p.id, 'name', p.name, 'slug', p.slug, 'description', p.description,
              'website', p.website, 'image_url', p.image_url, 'verified', p.verified) end as promoter,
            coalesce(lu.lineup, '[]'::json) as lineup,
            coalesce(im.images, '[]'::json) as images
       from events e
       left join venues v on v.id = e.venue_id
       left join promoters p on p.id = e.promoter_id
       cross join lateral (
         select count(*) filter (where mea.rsvp = 'going')::int as going_count,
                count(*) filter (where mea.rsvp = 'interested')::int as interested_count
           from member_event_actions mea where mea.event_id = e.id
       ) pop
       left join lateral (
         select json_agg(json_build_object('name', g.name, 'slug', g.slug) order by g.sort_order) as genres
           from event_genres eg join genres g on g.id = eg.genre_id where eg.event_id = e.id
       ) gj on true
       left join lateral (
         select json_agg(json_build_object('display_name', m.display_name, 'avatar_url', m.avatar_url)) as going_avatars
           from (
             select m2.display_name, m2.avatar_url
               from member_event_actions mea join members m2 on m2.id = mea.member_id
              where mea.event_id = e.id and mea.rsvp = 'going'
              order by mea.rsvp_at asc limit 6
           ) m
       ) av on true
       left join lateral (
         select json_agg(json_build_object('name', a.name, 'slug', a.slug,
                  'position', ea.position, 'billing', ea.billing) order by ea.position) as lineup
           from event_artists ea join artists a on a.id = ea.artist_id where ea.event_id = e.id
       ) lu on true
       left join lateral (
         select json_agg(json_build_object('url', i.url, 'alt', i.alt) order by i.sort_order) as images
           from event_images i where i.event_id = e.id
       ) im on true
      where e.slug = $1 ${includeUnpublished ? '' : `and e.status = 'live'`}`,
    [slug]
  );
}

export async function getTopLevelGenres(): Promise<GenreTag[]> {
  return query<GenreTag>(
    `select id, name, slug, parent_genre_id from genres
      where parent_genre_id is null and active
      order by sort_order, name`
  );
}

export async function getLiveCities(): Promise<{ city: string; country: string | null; n: number }[]> {
  return query(
    `select e.city, min(e.country) as country, count(*)::int as n
       from events e
      where e.status = 'live' and e.city is not null and ${UPCOMING_SQL}
      group by e.city order by n desc, e.city`
  ) as Promise<{ city: string; country: string | null; n: number }[]>;
}

export async function getMemberAction(
  memberId: string,
  eventId: string
): Promise<{ saved: boolean; rsvp: 'interested' | 'going' | null }> {
  const row = await queryOne<{ saved_at: string | null; rsvp: 'interested' | 'going' | null }>(
    `select saved_at, rsvp from member_event_actions where member_id = $1 and event_id = $2`,
    [memberId, eventId]
  );
  return { saved: !!row?.saved_at, rsvp: row?.rsvp ?? null };
}

export async function getGoingMembers(eventId: string): Promise<{
  going: { id: string; display_name: string; avatar_url: string | null; home_city: string | null; slug: string | null }[];
  interested: { id: string; display_name: string; avatar_url: string | null; home_city: string | null; slug: string | null }[];
}> {
  const rows = await query<{
    id: string; display_name: string; avatar_url: string | null;
    home_city: string | null; slug: string | null; rsvp: 'interested' | 'going';
  }>(
    `select m.id, m.display_name, m.avatar_url, m.home_city, m.slug, mea.rsvp
       from member_event_actions mea join members m on m.id = mea.member_id
      where mea.event_id = $1 and mea.rsvp is not null
      order by mea.rsvp_at asc`,
    [eventId]
  );
  return {
    going: rows.filter((r) => r.rsvp === 'going'),
    interested: rows.filter((r) => r.rsvp === 'interested'),
  };
}
