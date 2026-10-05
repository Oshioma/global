// MONTHLY SOURCE SUGGESTIONS: five drum & bass, five house and five hip hop
// promoters or clubs a month that are not sources yet, waiting on
// /admin/sources for an admin to Add or Dismiss.
//
// This is the discovery workbench run on a schedule, with the same rule:
// nothing a model says is believed. A candidate is only kept once we have
// fetched its listing page ourselves and the scanner found event links on it
// — so what lands in the panel has already passed the "Test" step an admin
// would otherwise do by hand. It is still never added on its own.
//
// Countries rotate: each genre searches the countries we already have sources
// in (plus any added to the short list on the panel), the ones that have gone
// longest without a search first. The job is safe to run more than once a
// month — it only tops each genre up to five, so a run that ran out of time
// is finished by the next one.

import { query, queryOne } from '@/lib/db';
import { canonicalCountry } from '@/lib/countries';
import { queueEmail } from '@/lib/email';
import { BRAND, button, centreRow, emailShell, esc, row } from '@/lib/emailBrand';
import { sourceTypeLabel } from '@/lib/util';
import {
  defaultDiscoveryClient, discoverSources,
  type DiscoveryClient, type SourceCandidate,
} from './discover';
import { probeTarget } from './probe';
import { testVerdict, type ProbeResult } from './verdict';

export const SUGGESTIONS_PER_GENRE = 5;

export const GENRE_BUCKETS = [
  { key: 'dnb', label: 'Drum & Bass', match: /drum\s*(&|and|n'?)?\s*bass|\bdnb\b|\bd&b\b|jungle/i },
  { key: 'house', label: 'House', match: /house/i },
  { key: 'hiphop', label: 'Hip Hop', match: /hip[\s-]?hop|\brap\b/i },
] as const;

export type GenreKey = (typeof GENRE_BUCKETS)[number]['key'];

export const genreLabel = (key: string) =>
  GENRE_BUCKETS.find((b) => b.key === key)?.label ?? key;

// Promoters and clubs were the ask. Festivals, listings sites and blogs are
// what the manual search is for.
const WANTED_KINDS = new Set(['venue_website', 'promoter_website']);

// How many countries one genre may search in a single run, and how long a run
// may take overall. Vercel stops the function at 300s; stopping early leaves
// time to save and answer, and the next run carries on.
const COUNTRIES_PER_RUN = 3;
const RUN_BUDGET_MS = 240_000;
const MIN_MS_FOR_SEARCH = 60_000;
const MIN_MS_FOR_PROBE = 20_000;

// The last scheduled day of the month's runs (see DEPLOYMENT.md). By then the
// batch is as full as it is going to get, so the email goes out regardless.
export const LAST_RUN_DAY = 7;

export function monthKey(d = new Date()): string {
  return d.toISOString().slice(0, 7);
}

export function hostOf(u: string): string | null {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

// Our own genre names for a bucket — "Deep House", "Tech House" and "House"
// all count as house — so the prompt speaks our taxonomy and an added source
// is tagged with genres we actually have.
export function bucketGenres<G extends { id: string; name: string }>(key: GenreKey, genres: G[]): G[] {
  const bucket = GENRE_BUCKETS.find((b) => b.key === key)!;
  return genres.filter((g) => bucket.match.test(g.name));
}

// Kept only when the scanner would actually find events there. A page that
// needs fixing first (client-rendered, wrong URL) is the manual workbench's
// job, not a monthly suggestion's.
export function probePassed(r: ProbeResult): boolean {
  return r.bot.ok && (r.candidates ?? 0) > 0 && !testVerdict(r).bad;
}

export type SuggestDeps = {
  client: DiscoveryClient;
  probe: (url: string) => Promise<ProbeResult>;
  now: () => number;
  notify: boolean;
};

export type BucketResult = {
  key: GenreKey;
  had: number;
  added: number;
  countries: string[];
  errors: string[];
};

export type SuggestResult = {
  month: string;
  buckets: BucketResult[];
  emailed: number;
  outOfTime: boolean;
};

const defaultDeps = (): SuggestDeps => ({
  client: defaultDiscoveryClient(),
  probe: (url) => probeTarget(url, { findListingOnMiss: true }),
  now: () => Date.now(),
  notify: true,
});

async function countriesToSearch(key: GenreKey, month: string): Promise<string[]> {
  const rows = await query<{ country: string }>(
    `select c.country
       from (select country from event_sources where country is not null and country <> ''
             union select country from source_suggestion_countries) c(country)
       left join source_suggestion_searches s on s.country = c.country and s.genre_key = $1
      where not exists (select 1 from source_suggestion_searches x
                         where x.country = c.country and x.genre_key = $1 and x.batch_month = $2)
      group by c.country
      order by max(s.created_at) nulls first, random()
      limit $3`,
    [key, month, COUNTRIES_PER_RUN]
  );
  // Spelling variants of one country collapse to one search.
  return [...new Set(rows.map((r) => canonicalCountry(r.country) || r.country))];
}

export async function runMonthlySuggestions(
  overrides: Partial<SuggestDeps> = {},
  at = new Date()
): Promise<SuggestResult> {
  const deps = { ...defaultDeps(), ...overrides };
  const started = deps.now();
  const left = () => RUN_BUDGET_MS - (deps.now() - started);
  const month = monthKey(at);

  const genres = await query<{ id: string; name: string }>(
    `select id, name from genres where active order by name`
  );

  // Never suggest something we already monitor, or anything suggested before
  // (a dismissed site stays dismissed).
  const [sources, suggested] = await Promise.all([
    query<{ url: string }>(`select url from event_sources`),
    query<{ host: string }>(`select host from source_suggestions`),
  ]);
  const seenHosts = new Set<string>([
    ...sources.map((s) => hostOf(s.url)).filter((h): h is string => !!h),
    ...suggested.map((s) => s.host),
  ]);

  const buckets: BucketResult[] = [];
  let outOfTime = false;

  for (const bucket of GENRE_BUCKETS) {
    const have = await queryOne<{ n: number }>(
      `select count(*)::int as n from source_suggestions where batch_month = $1 and genre_key = $2`,
      [month, bucket.key]
    );
    const result: BucketResult = { key: bucket.key, had: have?.n ?? 0, added: 0, countries: [], errors: [] };
    buckets.push(result);
    let need = SUGGESTIONS_PER_GENRE - result.had;
    if (need <= 0) continue;

    const names = bucketGenres(bucket.key, genres).map((g) => g.name);
    const promptGenres = names.length ? names : [bucket.label];

    for (const country of await countriesToSearch(bucket.key, month)) {
      if (need <= 0) break;
      if (left() < MIN_MS_FOR_SEARCH) { outOfTime = true; break; }
      result.countries.push(country);

      const outcome = await discoverSources(
        { country, city: null, genres: promptGenres, limit: 10 },
        deps.client
      );
      if (!outcome.ok) {
        result.errors.push(`${country}: ${outcome.detail}`);
        await logSearch(month, bucket.key, country, 0, 0, outcome.detail);
        // No API key is not going to fix itself on the next country.
        if (outcome.error === 'unavailable') break;
        continue;
      }

      const fresh = outcome.candidates.filter((c) => {
        const h = hostOf(c.url);
        return h && WANTED_KINDS.has(c.kind) && !seenHosts.has(h);
      });
      let kept = 0;
      for (const c of fresh) {
        if (need <= 0) break;
        if (left() < MIN_MS_FOR_PROBE) { outOfTime = true; break; }
        // Claimed before the probe so a site listed twice is tested once.
        seenHosts.add(hostOf(c.url)!);
        let probe: ProbeResult;
        try {
          probe = await deps.probe(c.url);
        } catch {
          continue;
        }
        if (!probePassed(probe)) continue;
        if (await saveSuggestion(month, bucket.key, country, c, probe, names)) {
          kept++;
          need--;
          result.added++;
        }
      }
      await logSearch(month, bucket.key, country, outcome.candidates.length, kept, null);
      if (outOfTime) break;
    }
    if (outOfTime) break;
  }

  let emailed = 0;
  if (deps.notify) {
    const full = buckets.length === GENRE_BUCKETS.length
      && buckets.every((b) => b.had + b.added >= SUGGESTIONS_PER_GENRE);
    if (full || at.getUTCDate() >= LAST_RUN_DAY) emailed = await emailAdmins(month);
  }

  return { month, buckets, emailed, outOfTime };
}

async function logSearch(
  month: string, key: string, country: string, proposed: number, kept: number, error: string | null
) {
  await query(
    `insert into source_suggestion_searches (batch_month, genre_key, country, proposed, kept, error)
     values ($1, $2, $3, $4, $5, $6)`,
    [month, key, country, proposed, kept, error?.slice(0, 300) ?? null]
  );
}

async function saveSuggestion(
  month: string, key: string, searchedCountry: string,
  c: SourceCandidate, probe: ProbeResult, bucketGenreNames: string[]
): Promise<boolean> {
  // The test may have found the real listing page behind the URL we were
  // given; that is the one worth adding.
  const url = probe.target || c.url;
  const host = hostOf(url) ?? hostOf(c.url)!;
  // The model's own genres, or the bucket's when it gave none we recognise.
  const own = c.genres.filter((g) => bucketGenreNames.some((n) => n.toLowerCase() === g.toLowerCase()));
  const row = await queryOne<{ id: string }>(
    `insert into source_suggestions
       (batch_month, genre_key, name, url, host, homepage, kind, city, country,
        searched_country, genres, note, candidates, verdict)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     on conflict (host) do nothing
     returning id`,
    [month, key, c.name, url, host, c.homepage, c.kind, c.city,
     canonicalCountry(c.country) || searchedCountry, searchedCountry,
     own.length ? own : c.genres.length ? c.genres : [genreLabel(key)],
     c.note, probe.candidates ?? 0, testVerdict(probe).text.slice(0, 500)]
  );
  return !!row;
}

// --- The email ---------------------------------------------------------------

type PendingRow = {
  genre_key: string; name: string; url: string; kind: string;
  city: string | null; country: string | null; candidates: number | null;
};

export function suggestionsEmail(month: string, rows: PendingRow[], link: string) {
  const monthName = new Date(`${month}-01T00:00:00Z`).toLocaleString('en-GB', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
  const where = (r: PendingRow) => [r.city, r.country].filter(Boolean).join(', ');
  const groups = GENRE_BUCKETS.map((b) => ({
    label: b.label,
    rows: rows.filter((r) => r.genre_key === b.key),
  })).filter((g) => g.rows.length);

  const subject = `${rows.length} new source suggestion${rows.length === 1 ? '' : 's'} for ${monthName} — Guestlist`;

  const bodyText = [
    `This month's source suggestions are ready (${monthName}).`,
    '',
    'Each one has already been fetched and tested against the scanner.',
    'Nothing is added until you press Add.',
    '',
    ...groups.flatMap((g) => [
      g.label.toUpperCase(),
      ...g.rows.map((r) => `  · ${r.name}${where(r) ? ` — ${where(r)}` : ''}\n    ${r.url}`),
      '',
    ]),
    `Review them: ${link}`,
  ].join('\n');

  const bodyHtml = emailShell({
    preheader: `${rows.length} promoters and clubs to look at, already tested against the scanner.`,
    rows: [
      row(`<div style="font-size:27px;line-height:1.12;font-weight:800;letter-spacing:-0.9px;color:${BRAND.ink};">
          Source suggestions for ${esc(monthName)}
        </div>
        <div style="font-size:14.5px;color:${BRAND.soft};margin-top:14px;line-height:1.65;">
          Each one has already been fetched and tested against the scanner.
          Nothing is added until you press Add.
        </div>`, '24px 26px 0'),
      ...groups.map((g) => row(`<div style="font-size:10.5px;font-weight:800;letter-spacing:2.2px;color:${BRAND.gold};text-transform:uppercase;">${esc(g.label)}</div>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:10px;">
          ${g.rows.map((r) => `
          <tr><td style="padding:0 0 8px 0;">
            <div style="border:1px solid ${BRAND.line};border-radius:12px;padding:12px 14px;background:${BRAND.surface};">
              <div style="font-size:14.5px;font-weight:750;color:${BRAND.ink};">${esc(r.name)}</div>
              <div style="font-size:12px;color:${BRAND.soft};margin-top:2px;">
                ${esc([sourceTypeLabel(r.kind), where(r)].filter(Boolean).join(' · '))}
                ${r.candidates ? ` · ${r.candidates} event link${r.candidates === 1 ? '' : 's'} found` : ''}
              </div>
              <div style="font-size:11.5px;margin-top:4px;word-break:break-all;">
                <a href="${esc(r.url)}" style="color:${BRAND.soft};">${esc(r.url)}</a>
              </div>
            </div>
          </td></tr>`).join('')}
        </table>`, '22px 26px 0')),
      centreRow(button(link, 'Review suggestions')),
    ].join(''),
    footerHtml: 'Sent to Guestlist admins once a month.',
  });

  return { subject, bodyText, bodyHtml };
}

async function emailAdmins(month: string): Promise<number> {
  const pending = await query<PendingRow>(
    `select genre_key, name, url, kind, city, country, candidates
       from source_suggestions
      where batch_month = $1 and status = 'pending'
      order by genre_key, created_at`,
    [month]
  );
  if (!pending.length) return 0;
  const link = `${process.env.SITE_URL ?? 'https://www.guestlist.net'}/admin/sources#suggestions`;
  const mail = suggestionsEmail(month, pending, link);
  const admins = await query<{ id: string; email: string }>(
    `select id, email from members where role = 'admin'`
  );
  let queued = 0;
  for (const a of admins) {
    // One email per admin per month, however many times the job runs.
    const r = await queueEmail({
      recipientEmail: a.email,
      memberId: a.id,
      emailType: 'notification:source_suggestions',
      subject: mail.subject,
      bodyText: mail.bodyText,
      bodyHtml: mail.bodyHtml,
      dedupeKey: `source_suggestions:${month}:${a.id}`,
    });
    if (r.outcome === 'queued') queued++;
  }
  return queued;
}
