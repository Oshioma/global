-- MONTHLY SOURCE SUGGESTIONS.
--
-- Once a month a scheduled job (/api/jobs/suggest-sources, driven by Supabase
-- pg_cron — see DEPLOYMENT.md) proposes five drum & bass, five house and five
-- hip hop promoters or clubs that are not sources yet. Each one has already
-- been fetched and tested against the scanner; nothing is added until an
-- admin presses Add on /admin/sources.
--
-- A site is suggested at most once, ever: the unique host means a dismissed
-- suggestion stays dismissed instead of coming back next month.

create table if not exists source_suggestions (
  id uuid primary key default gen_random_uuid(),
  batch_month text not null,                 -- 'YYYY-MM'
  genre_key text not null check (genre_key in ('dnb', 'house', 'hiphop')),
  name text not null,
  url text not null,                         -- the listing page that passed the test
  host text not null,
  homepage text,
  kind text not null,
  city text,
  country text,
  searched_country text not null,
  genres text[] not null default '{}',
  note text,
  candidates int,
  verdict text,
  status text not null default 'pending' check (status in ('pending', 'added', 'dismissed')),
  source_id uuid references event_sources(id) on delete set null,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid references members(id) on delete set null
);

create unique index if not exists source_suggestions_host_key on source_suggestions (host);
create index if not exists source_suggestions_month_idx
  on source_suggestions (batch_month, genre_key, status);

-- Every country searched, per genre, so the rotation can pick the ones that
-- have waited longest — including the searches that found nothing.
create table if not exists source_suggestion_searches (
  id uuid primary key default gen_random_uuid(),
  batch_month text not null,
  genre_key text not null,
  country text not null,
  proposed int not null default 0,
  kept int not null default 0,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists source_suggestion_searches_rotation_idx
  on source_suggestion_searches (genre_key, country, created_at desc);

-- Countries to search beyond the ones we already have sources in.
create table if not exists source_suggestion_countries (
  country text primary key,
  added_at timestamptz not null default now(),
  added_by uuid references members(id) on delete set null
);

-- Backend-only, like every other table here (see migration 042).
alter table source_suggestions enable row level security;
alter table source_suggestion_searches enable row level security;
alter table source_suggestion_countries enable row level security;
