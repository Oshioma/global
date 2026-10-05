-- Hip hop suggestions search the United States a city at a time (see
-- lib/supply/suggest.ts), so a search is logged with its city as well as its
-- country, and the rotation can tell Atlanta from New York.

alter table source_suggestion_searches add column if not exists city text;
