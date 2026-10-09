// WHICH GENRES ARE SELECTED on /events.
//
// The `genre` query parameter is a comma-separated list of slugs
// (?genre=house,jungle); a single slug, as older links carry, is a list of
// one. Pure, so the server page and the client filter controls agree.
//
// Some genres travel together. Drum & bass and jungle are one scene in
// practice — the same nights, the same crowd — but separate genres in the
// taxonomy (jungle is not a subgenre of drum & bass). So choosing drum & bass
// selects jungle with it, and un-choosing drum & bass lets it go again.
// Jungle on its own can still be chosen and un-chosen by itself.

export const GENRE_COMPANIONS: Record<string, string[]> = {
  'drum-and-bass': ['jungle'],
};

const SLUG = /^[a-z0-9][a-z0-9-]{0,59}$/;
const MAX_GENRES = 12;

export function parseGenres(raw: string | string[] | null | undefined): string[] {
  const parts = (Array.isArray(raw) ? raw : [raw ?? ''])
    .flatMap((v) => String(v).split(','))
    .map((s) => s.trim().toLowerCase())
    .filter((s) => SLUG.test(s));
  return [...new Set(parts)].slice(0, MAX_GENRES);
}

export function genresParam(slugs: string[]): string | null {
  return slugs.length ? slugs.join(',') : null;
}

// Add a genre and anything that travels with it.
export function withCompanions(slug: string): string[] {
  return [slug, ...(GENRE_COMPANIONS[slug] ?? [])];
}

// Press a genre chip: on if it was off (with its companions), off if it was
// on (and its companions with it).
export function toggleGenre(selected: string[], slug: string): string[] {
  const group = withCompanions(slug);
  if (selected.includes(slug)) return selected.filter((s) => !group.includes(s));
  return [...new Set([...selected, ...group])];
}
