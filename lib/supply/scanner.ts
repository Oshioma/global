// Constrained source scanning: KNOWN SOURCE PAGE → EVENT LINKS, never a
// crawler. One fetch of the source page (or its feed), deterministic
// candidate-link identification, seen-URL memory, hard caps, politeness
// delay, per-scan metrics.

import { parse } from 'node-html-parser';
import { query, queryOne } from '@/lib/db';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from './safeFetch';
import { runExtractionPipeline, type PipelineContext } from './pipeline';
import { supplyConfig } from './config';
import { fetcherFor } from './render';
import type { OutcomeTally } from './outcomes';
import { refreshAdminReviewDigest } from '@/lib/adminNotify';

export type SourceRow = {
  id: string;
  name: string;
  url: string;
  feed_url: string | null;
  source_type: string;
  active: boolean;
  trust: string;
  polling_enabled: boolean;
  render_js: boolean;
  max_candidates: number | null;
  poll_frequency_hours: number;
  last_checked_at: string | null;
};

// Guestlist is not an English-language platform, and these paths are how the
// rest of the world writes "events". Missing them meant an Italian club's
// /eventi/... links were discarded as though they were navigation — the site
// looked empty when it was full.
export const EVENT_PATH_HINT = new RegExp(
  '\\/(' + [
    // English
    'events?', 'whats?-?on', 'what-s-on', 'listings?', 'gigs?', 'parties', 'party',
    'nights?', 'programme', 'program', 'lineup', 'agenda', 'tickets?', 'shows?', 'e',
    // Italian
    'eventi', 'evento', 'serate', 'serata', 'concerti', 'biglietti',
    // Spanish / Portuguese
    'eventos', 'fiestas', 'festas', 'conciertos', 'entradas', 'ingressos',
    // French
    'evenements?', 'soirees?', 'billetterie', 'concerts',
    // German
    'veranstaltungen', 'veranstaltung', 'termine', 'programm', 'konzerte',
    // Dutch
    'evenementen', 'programma',
  ].join('|') + ')\\/[^/]',
  'i'
);
const NON_EVENT_PATH = new RegExp(
  '\\/(' + [
    'login', 'signin', 'signup', 'register', 'account', 'cart', 'basket', 'checkout',
    'privacy', 'terms', 'cookies', 'about', 'contact', 'jobs', 'careers', 'press',
    'faq', 'search', 'tag', 'category', 'wp-admin', 'admin',
    // The same dead ends in the languages above.
    'chi-siamo', 'contatti', 'informativa', 'contacto', 'sobre', 'quienes-somos',
    'a-propos', 'mentions-legales', 'impressum', 'datenschutz', 'kontakt',
    'ueber-uns', 'over-ons', 'privacybeleid',
  ].join('|') + ')\\b',
  'i'
);
const DATE_TEXT = /\b(\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|(mon|tue|wed|thu|fri|sat|sun)[a-z]*\s+\d{1,2}|\d{1,2}[./]\d{1,2}[./]\d{2,4})\b/i;

// HOW MANY CANDIDATES ONE SCAN MAY TAKE.
//
// Forty is right for a venue: a club with more than forty upcoming nights is
// rarer than a bug in our reader, and the cap is what stops a mis-read page
// turning into a thousand fetches. It is wrong for a festival programme —
// ADE's is hundreds, and a cap that silently stops at forty is a listing
// truncated with no sign that it happened.
//
// So a source may carry its own, and the default stands for everything that
// does not.
export function candidateCap(source?: { max_candidates?: number | null } | null): number {
  const own = source?.max_candidates;
  return own && own > 0 ? own : supplyConfig.scan.maxCandidatesPerScan;
}

export function canonicaliseCandidateUrl(raw: string, baseUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(raw, baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.hostname = url.hostname.toLowerCase();
  // Strip tracking params; keep functional ones.
  const params = new URLSearchParams();
  for (const [k, v] of url.searchParams) {
    if (!/^(utm_|fbclid|gclid|mc_|ref$|source$)/i.test(k)) params.set(k, v);
  }
  url.search = params.toString() ? `?${params.toString()}` : '';
  return url.toString();
}

// A LISTING PAGE'S OWN FILTERS ARE NOT EVENTS.
//
// ADE's programme is one path, /en/program/filter/, re-queried for every view
// of it. Its four "candidate event links" were that same page again with
// ?section=persons, ?section=venues and a different type — its own tabs. They
// passed because the PATH says programme, and the path is the same path we
// are standing on.
//
// So: same path as the page we fetched is navigation, UNLESS the link
// introduces a query key the page itself does not have. That exception is
// what keeps an older site's /events/?id=1234 — an id is identity, a narrower
// value of a key the page already carries is a facet.
//
// Compared against every URL that describes the page: the one we ASKED for as
// well as the one we ended up at. A site that redirects
// /program/filter/?section=events&category=… to /program/filter/ would
// otherwise look like a page with no query at all, and its own tabs would
// come back as links "introducing" section and category — facets promoted to
// events by a redirect.
export function isFacetOfPage(candidate: URL, ...pages: URL[]): boolean {
  const known = new Set<string>();
  let samePath = false;
  const candPath = candidate.pathname.replace(/\/+$/, '');
  for (const page of pages) {
    if (page.pathname.replace(/\/+$/, '') !== candPath) continue;
    samePath = true;
    for (const key of page.searchParams.keys()) known.add(key);
  }
  if (!samePath) return false;
  for (const key of candidate.searchParams.keys()) {
    if (!known.has(key)) return false;
  }
  return true;
}

// How many links on the page were the page again under a different filter.
// Reported rather than silently dropped, because "0 candidates" where there
// were 4 a moment ago needs a reason, and "those four were your own tabs" is
// the reason.
export function pageFilterLinks(html: string, pageUrl: string, requestedUrl?: string): number {
  const base = new URL(pageUrl);
  const asked = new URL(requestedUrl ?? pageUrl);
  const seen = new Set<string>();
  for (const a of parse(html).querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    const canonical = href && canonicaliseCandidateUrl(href, pageUrl);
    if (!canonical || seen.has(canonical)) continue;
    let url: URL;
    try { url = new URL(canonical); } catch { continue; }
    if (!EVENT_PATH_HINT.test(url.pathname)) continue;
    if (isFacetOfPage(url, base, asked)) seen.add(canonical);
  }
  return seen.size;
}

// A LISTING THAT ARRIVES A PAGE AT A TIME.
//
// ADE's programme is served from /api/program/filter/?…&page=0 — an HTML
// fragment, one page of results, exactly the shape our reader already
// handles. Read page 0 and stop, though, and a five-day festival becomes
// however many events fit in one screenful.
//
// Only these parameters, and only when the value is already a whole number.
// Guessing at ?offset= or ?start= means guessing the page size too, and a
// wrong guess silently skips events rather than failing loudly.
const PAGE_PARAMS = ['page', 'p', 'pg', 'pagina', 'seite', 'pagenum', 'page_num'];

export function nextPageUrl(current: string): string | null {
  let url: URL;
  try { url = new URL(current); } catch { return null; }
  for (const key of PAGE_PARAMS) {
    const raw = url.searchParams.get(key);
    if (raw === null || !/^\d{1,6}$/.test(raw)) continue;
    url.searchParams.set(key, String(Number(raw) + 1));
    return url.toString();
  }
  return null;
}

export function isPaged(current: string): boolean {
  return nextPageUrl(current) !== null;
}

// A LISTING THAT IS NOT A PAGE AT ALL.
//
// ADE's programme endpoint answers with `content-type: text/html` and a body
// that is nothing of the sort:
//
//   {"data":[{"id":2812228,"title":"Big Bells x Audiosolo ADE 2026",
//     "url":"https://www.amsterdam-dance-event.nl/en/program/2026/…/2812228/",
//     "venue":{"title":"Club Baggerbeest"},…}]}
//
// A reader that trusts the header looks for <a href> in that, finds none, and
// reports an empty site. So the body decides what it is, not the header — and
// the rule for what counts as an event link is the same one everywhere else:
// a same-site path that looks like an event page.
//
// Only the URLs are trusted, never the shape. Every site invents its own
// field names, and a reader that guesses at "title" or "startDate" is a
// reader that silently mis-imports the day somebody renames a key.
export function looksLikeJson(body: string): boolean {
  const head = body.trimStart()[0];
  return head === '{' || head === '[';
}

export function identifyJsonLinks(body: string, pageUrl: string, requestedUrl?: string, limit = candidateCap()): string[] {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return []; }

  const base = new URL(pageUrl);
  const asked = new URL(requestedUrl ?? pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();

  const consider = (value: string) => {
    if (out.length >= limit) return;
    if (!/^https?:\/\//i.test(value) && !value.startsWith('/')) return;
    const canonical = canonicaliseCandidateUrl(value, pageUrl);
    if (!canonical || seen.has(canonical)) return;
    let url: URL;
    try { url = new URL(canonical); } catch { return; }
    if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) return;
    if (NOT_A_PAGE.test(url.pathname) || A_FILE.test(url.pathname)) return;
    if (NON_EVENT_PATH.test(url.pathname)) return;
    if (!EVENT_PATH_HINT.test(url.pathname)) return;
    if (isFacetOfPage(url, base, asked)) return;
    seen.add(canonical);
    out.push(canonical);
  };

  // Depth-limited so a pathological document cannot walk forever.
  const walk = (node: unknown, depth: number) => {
    if (depth > 12 || out.length >= limit) return;
    if (typeof node === 'string') return consider(node);
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (node && typeof node === 'object') {
      for (const value of Object.values(node as Record<string, unknown>)) walk(value, depth + 1);
    }
  };
  walk(parsed, 0);
  return out;
}

export function identifyCandidateLinks(html: string, pageUrl: string, requestedUrl?: string, limit = candidateCap()): string[] {
  const root = parse(html);
  const base = new URL(pageUrl);
  // What we asked for, when a redirect landed us somewhere plainer.
  const asked = new URL(requestedUrl ?? pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();
  const pageCanonical = canonicaliseCandidateUrl(pageUrl, pageUrl);

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (!href) continue;
    const canonical = canonicaliseCandidateUrl(href, pageUrl);
    if (!canonical || canonical === pageCanonical || seen.has(canonical)) continue;
    let url: URL;
    try {
      url = new URL(canonical);
    } catch {
      continue;
    }
    if (NON_EVENT_PATH.test(url.pathname)) continue;
    if (isFacetOfPage(url, base, asked)) continue;

    const sameSite = url.hostname.replace(/^www\./, '') === base.hostname.replace(/^www\./, '');
    const pathLooksEventy = EVENT_PATH_HINT.test(url.pathname);
    const text = `${a.structuredText} ${a.getAttribute('aria-label') ?? ''} ${a.getAttribute('title') ?? ''}`;
    const textLooksDated = DATE_TEXT.test(text);

    // Deterministic signals only: event-like path anywhere, or a same-site
    // link whose visible text carries a date.
    if (pathLooksEventy || (sameSite && textLooksDated)) {
      seen.add(canonical);
      out.push(canonical);
      if (out.length >= limit) break;
    }
  }

  // Nothing in the markup, or barely anything. Before writing the page off as
  // "renders in the browser", look at the data it was served WITH.
  if (out.length < EMBEDDED_FLOOR) {
    for (const url of identifyEmbeddedLinks(html, pageUrl, requestedUrl)) {
      if (seen.has(url)) continue;
      seen.add(url);
      out.push(url);
      if (out.length >= limit) break;
    }
  }
  return out;
}

// Below this many links in the markup, a page is worth reading twice. A page
// that already gave us a proper list is left alone — no point rummaging
// through its scripts for links we have.
const EMBEDDED_FLOOR = 5;

// Paths that are plumbing, not pages. An embedded payload is full of them.
const NOT_A_PAGE = /\/(api|wp-json|graphql|_next|_nuxt|static|assets|cdn-cgi)\//i;
const A_FILE = /\.(json|jsonp|js|mjs|css|map|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|eot|xml|txt|pdf|zip|mp4|webm|mp3)$/i;

// EVENT LINKS THAT ARE IN THE PAGE BUT NOT IN ITS MARKUP.
//
// A modern listing page is often server-rendered as an empty shell plus the
// data to fill it: Next.js parks it in __NEXT_DATA__, Nuxt in window.__NUXT__,
// others in a plain <script type="application/json">. There is no API call to
// find in the network panel, because the answer travelled with the document —
// which is exactly why such a page looks empty to a reader that only knows
// about <a href>, and why "check the network tab" comes back with nothing.
//
// The rule is the same one the markup pass uses: a same-site path that looks
// like an event page. Nothing here trusts the JSON's shape, because every site
// invents its own — it only trusts the URLs, which are the site's own.
export function identifyEmbeddedLinks(html: string, pageUrl: string, requestedUrl?: string, limit = candidateCap()): string[] {
  const root = parse(html);
  const base = new URL(pageUrl);
  const asked = new URL(requestedUrl ?? pageUrl);
  const pageCanonical = canonicaliseCandidateUrl(pageUrl, pageUrl);
  const out: string[] = [];
  const seen = new Set<string>();

  for (const script of root.querySelectorAll('script')) {
    const raw = script.rawText;
    if (!raw || raw.length < 32) continue;
    // JSON embedded in JS escapes its slashes, and Next.js flight payloads
    // escape them twice over. Undo that before looking for paths.
    const text = raw.replace(/\\u002[fF]/g, '/').replace(/\\\//g, '/');

    for (const m of text.matchAll(/["'`\\](https?:\/\/[^"'`\\\s<>]{6,300}|\/[a-z0-9][^"'`\\\s<>]{4,300})["'`\\]/gi)) {
      const canonical = canonicaliseCandidateUrl(m[1], pageUrl);
      if (!canonical || canonical === pageCanonical || seen.has(canonical)) continue;
      let url: URL;
      try { url = new URL(canonical); } catch { continue; }
      // Same site only. An embedded payload carries every CDN, analytics and
      // font host the page uses, and none of those are event pages.
      if (url.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
      if (NOT_A_PAGE.test(url.pathname) || A_FILE.test(url.pathname)) continue;
      if (NON_EVENT_PATH.test(url.pathname)) continue;
      if (isFacetOfPage(url, base, asked)) continue;
      if (!EVENT_PATH_HINT.test(url.pathname)) continue;
      seen.add(canonical);
      out.push(canonical);
      if (out.length >= limit) return out;
    }
  }
  return out;
}

// A sitemap is not a feed and is not a page. It gets recognised on its own,
// because an admin whose listing page renders in the browser is told to point
// the source AT the sitemap — and that advice only works if a sitemap given as
// the source URL is read as one instead of parsed as HTML (which finds
// nothing, because a sitemap has no <a href> in it).
export function looksLikeSitemap(body: string): boolean {
  return /<(urlset|sitemapindex)[\s>]/i.test(body);
}

export function looksLikeFeed(contentType: string, body: string): boolean {
  if (/rss|atom|xml/i.test(contentType) && /<(rss|feed)[\s>]/i.test(body)) return true;
  return /^\s*(<\?xml[^>]*\?>)?\s*<(rss|feed)[\s>]/i.test(body);
}

// Regex-based feed parsing: <link> is a void element to HTML parsers, so an
// HTML parser silently loses RSS link text — plain pattern matching over the
// XML is the reliable route for the two well-known shapes.
export function parseFeedLinks(xml: string, baseUrl: string, limit = candidateCap()): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (u: string | null | undefined) => {
    const decoded = u?.trim().replace(/&amp;/g, '&').replace(/^<!\[CDATA\[(.*)\]\]>$/s, '$1').trim();
    const canonical = decoded && canonicaliseCandidateUrl(decoded, baseUrl);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      out.push(canonical);
    }
  };
  // RSS 2.0: <item>…<link>url</link>… (fall back to a URL-shaped <guid>)
  for (const m of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/gi)) {
    const item = m[0];
    const link = item.match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1]
      ?? item.match(/<guid[^>]*>(https?:\/\/[\s\S]*?)<\/guid>/i)?.[1];
    push(link);
    if (out.length >= limit) return out;
  }
  // Atom: <entry>…<link href="url"/>… (prefer rel="alternate")
  for (const m of xml.matchAll(/<entry[\s>][\s\S]*?<\/entry>/gi)) {
    const entry = m[0];
    const links = [...entry.matchAll(/<link\b[^>]*href=["']([^"']+)["'][^>]*>/gi)];
    const alternate = links.find((l) => /rel=["']alternate["']/i.test(l[0]) || !/rel=/i.test(l[0]));
    push(alternate?.[1] ?? links[0]?.[1]);
    if (out.length >= limit) return out;
  }
  return out;
}

// Sitemaps exist for crawlers, so a site that serves JavaScript to browsers
// and 403s our bot on its listing page will often still serve a plain list
// of its event URLs here. It is the one honest way past both failure modes
// without pretending to be a browser.
const SITEMAP_PATHS = ['/sitemap.xml', '/sitemap_index.xml'];

// ASK THE SITE WHERE ITS SITEMAPS ARE.
//
// /sitemap.xml is a convention, not a rule, and on a big site it is often the
// least interesting one — ADE's holds /en/about/ and nothing else, while its
// programme lives somewhere our two guessed paths never look. robots.txt is
// where a site DECLARES its sitemaps, and it is the mechanism every crawler
// uses. We were guessing at a door the site had already given us the key to.
//
// Read only for the Sitemap: lines. Nothing here interprets a rule about what
// may be fetched; that is a separate question from where the sitemaps are.
export function sitemapsFromRobots(body: string, baseUrl: string): string[] {
  const out: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (!m) continue;
    const canonical = canonicaliseCandidateUrl(m[1], baseUrl);
    if (!canonical || out.includes(canonical)) continue;
    let url: URL;
    try { url = new URL(canonical); } catch { continue; }
    // Same site only: a declared sitemap on somebody else's host is not this
    // site's to hand us, and following it would be a crawl we did not intend.
    if (url.hostname.replace(/^www\./, '') !== new URL(baseUrl).hostname.replace(/^www\./, '')) continue;
    out.push(canonical);
    if (out.length >= ROBOTS_SITEMAP_LIMIT) break;
  }
  return out;
}

// Enough to cover a site that splits by section or by year, few enough that a
// misconfigured robots.txt cannot turn one scan into a crawl.
const ROBOTS_SITEMAP_LIMIT = 10;

// How a sitemap is asked for, in one place: XML, and a budget that fits one.
export const sitemapFetchOptions = (): SafeFetchOptions => ({
  accept: 'application/xml,text/xml',
  maxBytes: supplyConfig.fetch.maxSitemapBytes,
});

export function sitemapEventUrls(xml: string, baseUrl: string, limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const raw = m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim();
    const canonical = raw && canonicaliseCandidateUrl(raw, baseUrl);
    if (!canonical || seen.has(canonical)) continue;
    let url: URL;
    try { url = new URL(canonical); } catch { continue; }
    // Only event-shaped paths: a sitemap lists the whole site, and importing
    // its about page as an event helps nobody.
    if (!EVENT_PATH_HINT.test(url.pathname)) continue;
    seen.add(canonical);
    out.push(canonical);
    if (out.length >= limit) break;
  }
  return out;
}

// Every <loc> in a sitemap, event-shaped or not. Nothing imports these — they
// exist so a sitemap that yields no events can SHOW what it does contain
// instead of reporting an empty site. A dead end that shows its work is a
// clue; one that says \"no event links found\" is a shrug.
export function countSitemapUrls(xml: string): number {
  let n = 0;
  for (const _m of xml.matchAll(/<loc>[\s\S]*?<\/loc>/gi)) n++;
  return n;
}

export function sitemapAllUrls(xml: string, baseUrl: string, limit: number): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const canonical = canonicaliseCandidateUrl(
      m[1].replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1').trim(), baseUrl);
    if (canonical && !out.includes(canonical)) out.push(canonical);
    if (out.length >= limit) break;
  }
  return out;
}

// A big site splits its sitemap by section, and the events are never in the
// first one — ADE's index lists news, pages, artists and then the programme.
// Reading two children and giving up is how a site with 900 event URLs came
// back empty.
const EVENTY_SITEMAP = /(event|program|agenda|what-?s-?on|listing|show|part(y|ies)|gig|concert|serat|evenement|veranstaltung)/i;

// A sitemap index points at other sitemaps rather than pages. Ordered so the
// ones named after events are opened first: same budget, far better odds.
export function sitemapIndexUrls(xml: string, baseUrl: string, limit: number): string[] {
  if (!/<sitemapindex[\s>]/i.test(xml)) return [];
  const all = sitemapAllUrls(xml, baseUrl, SITEMAP_INDEX_SCAN);
  const eventy = all.filter((u) => EVENTY_SITEMAP.test(u));
  const rest = all.filter((u) => !EVENTY_SITEMAP.test(u));
  return [...eventy, ...rest].slice(0, limit);
}

// How many children of an index we are willing to consider, and how many we
// will actually fetch. Ordered eventy-first, so the fetch budget is spent on
// the ones that can plausibly answer.
const SITEMAP_INDEX_SCAN = 200;
export const SITEMAP_CHILDREN_TO_FETCH = 8;

export async function findSitemapEvents(
  origin: string,
  fetcher: (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>,
  delayMs = supplyConfig.scan.delayBetweenFetchesMs,
  // A sitemap already walked by the caller. Pointing the source straight at
  // /sitemap.xml and finding nothing is exactly when the site's OTHER
  // sitemaps matter most, so we come here — and re-reading the one we just
  // read would only produce the same nothing, more slowly.
  alreadyTried: string[] = []
): Promise<{ url: string; found: number; urls: string[]; sample?: string[]; skipped?: string[]; urlsSeen?: number; sitemapsRead?: number } | null> {
  let sample: string[] = [];
  let skipped: string[] = [];
  let urlsSeen = 0;
  let sitemapsRead = 0;

  // What the site says first, then the two conventional paths. A declared
  // sitemap is the site telling us where to look; the paths are us guessing.
  const robots = await fetcher(`${origin}/robots.txt`, { accept: 'text/plain' });
  const declared = robots.ok ? sitemapsFromRobots(robots.body, origin) : [];
  const targets = [...declared];
  for (const path of SITEMAP_PATHS) {
    if (!targets.includes(`${origin}${path}`)) targets.push(`${origin}${path}`);
  }
  const skip = new Set(alreadyTried.map((u) => canonicaliseCandidateUrl(u, origin) ?? u));

  for (const target of targets) {
    if (skip.has(canonicaliseCandidateUrl(target, origin) ?? target)) continue;
    await sleep(delayMs);
    const res = await fetcher(target, sitemapFetchOptions());
    if (!res.ok || !/<(urlset|sitemapindex)[\s>]/i.test(res.body)) continue;

    const walked = await walkSitemap(res, fetcher, delayMs);
    if (walked.found.length) {
      return { url: walked.url, found: walked.found.length, urls: walked.found, sample: walked.sample };
    }
    if (walked.sample.length) sample = walked.sample;
    if (walked.skipped.length) skipped = walked.skipped;
    urlsSeen += walked.urlsSeen;
    sitemapsRead += walked.sitemapsRead;
  }
  return sample.length || skipped.length || sitemapsRead
    ? { url: targets[0] ?? `${origin}${SITEMAP_PATHS[0]}`, found: 0, urls: [], sample, skipped, urlsSeen, sitemapsRead }
    : null;
}

export type SitemapWalk = {
  url: string;
  found: string[];
  sample: string[];
  skipped: string[];
  // Every <loc> we actually read, across the index and its children. "3
  // sitemaps, 4,812 URLs, none event-shaped" and "1 sitemap, 1 URL" are
  // different diagnoses, and until now both came back the same sentence.
  urlsSeen: number;
  sitemapsRead: number;
};

// Read one sitemap response for event URLs, stepping into an index when the
// top level has none. Shared by the scan and the probe so a \"test fetch\"
// cannot report something the scan would not do.
export async function walkSitemap(
  res: { body: string; finalUrl: string },
  fetcher: (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>,
  delayMs = supplyConfig.scan.delayBetweenFetchesMs,
  cap = candidateCap()
): Promise<SitemapWalk> {
  const direct = sitemapEventUrls(res.body, res.finalUrl, cap);
  if (direct.length) return { url: res.finalUrl, found: direct, sample: [], skipped: [], urlsSeen: countSitemapUrls(res.body), sitemapsRead: 1 };

  const children = sitemapIndexUrls(res.body, res.finalUrl, SITEMAP_CHILDREN_TO_FETCH);
  // Not an index, just a sitemap with nothing event-shaped in it. Report what
  // it DOES list, so the shape of the site's URLs is visible.
  if (!children.length) {
    return { url: res.finalUrl, found: [], sample: sitemapAllUrls(res.body, res.finalUrl, 8), skipped: [], urlsSeen: countSitemapUrls(res.body), sitemapsRead: 1 };
  }

  let sample: string[] = [];
  const skipped: string[] = [];
  let urlsSeen = countSitemapUrls(res.body);
  let sitemapsRead = 1;
  for (const child of children) {
    await sleep(delayMs);
    const sub = await fetcher(child, sitemapFetchOptions());
    // A child we could not read is not the same as a child with no events in
    // it, and swallowing the difference is how "too big to fetch" came back
    // as "this site has no events".
    if (!sub.ok) { skipped.push(`${child} (${sub.code})`); continue; }
    sitemapsRead++;
    urlsSeen += countSitemapUrls(sub.body);
    const found = sitemapEventUrls(sub.body, sub.finalUrl, cap);
    if (found.length) return { url: sub.finalUrl, found, sample: [], skipped, urlsSeen, sitemapsRead };
    if (!sample.length) sample = sitemapAllUrls(sub.body, sub.finalUrl, 8);
  }
  return { url: res.finalUrl, found: [], sample, skipped, urlsSeen, sitemapsRead };
}


export type ScanContext = Pick<PipelineContext, 'ai' | 'fetcher' | 'fetchOptions'> & {
  delayMs?: number;
  // How long this scan is allowed to take, in wall-clock milliseconds.
  // Tests pass a tiny one to prove the stop is real without waiting for it.
  budgetMs?: number;
};

export type ScanResult = {
  scanId: string;
  status: 'succeeded' | 'failed';
  method: 'rss' | 'html' | 'sitemap' | 'json' | null;
  candidatesFound: number;
  newCandidates: number;
  extracted: number;
  failed: number;
  duplicates: number;
  error: string | null;
  // True when this scan is the one that put the source on a schedule.
  // True when this scan brought events back from a source that is NOT on the
  // schedule — an offer for the desk, never an action taken on its own.
  couldPoll: boolean;
  // Every extraction status this scan produced, counted. "0 extracted" is
  // not a diagnosis; "5 not_an_event" is.
  outcomes: OutcomeTally;
  // Set when the scan stopped early — how much it left for the next one.
  note: string | null;
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A paged listing keeps going. Stop the moment a page adds nothing new — that
// is the end of the results, and it is also what a site does when it ignores a
// page number it has run out of, so one check covers both.
//
// Shared by the HTML and JSON readers, because a listing being paginated has
// nothing to do with what format it is served in — and ADE's is both.
async function followPages(
  first: string[],
  target: string,
  read: (body: string, at: string, asked: string) => string[],
  fetcher: (url: string, options?: SafeFetchOptions) => Promise<SafeFetchResult>,
  ctx: ScanContext,
  limit = candidateCap(),
  deadline = Infinity
): Promise<string[]> {
  if (!isPaged(target)) return first;
  const candidates = [...first];
  const seen = new Set(candidates);
  let pageUrl: string | null = target;
  for (let page = 0; page < supplyConfig.listing.maxPagesPerScan; page++) {
    if (candidates.length >= limit) break;
    // Twenty pages at a twelve-second fetch timeout is four minutes spent
    // before a single event is read. The clock stops the walk too.
    if (Date.now() > deadline) break;
    pageUrl = nextPageUrl(pageUrl);
    if (!pageUrl) break;
    await sleep(ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs);
    const next = await fetcher(pageUrl, {
      ...ctx.fetchOptions,
      accept: 'text/html,application/xhtml+xml,application/json,application/xml;q=0.9',
    });
    if (!next.ok) break;
    const fresh = read(next.body, next.finalUrl, pageUrl).filter((u) => !seen.has(u));
    if (!fresh.length) break;
    for (const u of fresh) { seen.add(u); candidates.push(u); }
  }
  return candidates.slice(0, limit);
}

// A SCAN IS A JOB, NOT A REQUEST.
//
// Starting one is instant: a row appears, and its id is what the desk watches.
// The work happens after, on whatever clock the caller gives it. Holding an
// HTTP request open for the whole thing was what left the desk spinning for
// ever on a big site — the browser waited on a function that had already been
// killed, and nothing was ever written down.
export async function startScan(sourceId: string): Promise<string> {
  // Anything still calling itself 'running' past its budget was killed. Say so
  // now, so a stale row can never be mistaken for this scan.
  await sweepStaleScans(sourceId);
  const scan = await queryOne<{ id: string }>(
    `insert into source_scans (source_id) values ($1) returning id`,
    [sourceId]
  );
  return scan!.id;
}

// A row left 'running' long past any budget did not finish; it died. Finishing
// it honestly is what lets the desk tell "still working" from "gone".
export async function sweepStaleScans(sourceId?: string): Promise<number> {
  const rows = await query<{ id: string }>(
    `update source_scans set status = 'failed', finished_at = now(),
            error = coalesce(error, 'Scan stopped before it finished')
      where status = 'running'
        and started_at < now() - make_interval(secs => $1::float)
        and ($2::uuid is null or source_id = $2)
      returning id`,
    [supplyConfig.scan.staleAfterMs / 1000, sourceId ?? null]
  );
  return rows.length;
}

export async function scanSource(sourceId: string, ctx: ScanContext = {}): Promise<ScanResult> {
  return runScan(sourceId, await startScan(sourceId), ctx);
}

export async function runScan(sourceId: string, scanId: string, ctx: ScanContext = {}): Promise<ScanResult> {
  const source = await queryOne<SourceRow>(
    `select id, name, url, feed_url, source_type, active, trust, polling_enabled,
            poll_frequency_hours, render_js, max_candidates, last_checked_at::text
       from event_sources where id = $1`,
    [sourceId]
  );
  if (!source) throw new Error('Source not found');

  // Everything this scan does happens before this moment.
  const deadline = Date.now() + (ctx.budgetMs ?? supplyConfig.scan.budgetMs);
  // A source flagged as client-rendered goes through a hosted browser; every
  // other source, and every source when no renderer is configured, fetches
  // exactly as it always has. A test's own fetcher always wins — the suite
  // must never reach a network, rendering or not.
  const fetcher = ctx.fetcher ?? fetcherFor(source.render_js);

  const finish = async (
    r: Omit<ScanResult, 'scanId' | 'couldPoll' | 'outcomes' | 'note'> & { outcomes?: OutcomeTally; note?: string | null }
  ): Promise<ScanResult> => {
    await query(
      `update source_scans set status = $2, method = $3, candidates_found = $4,
              new_candidates = $5, extracted = $6, failed = $7, duplicates = $8,
              error = $9, outcomes = $10, note = $11, finished_at = now()
        where id = $1`,
      [scanId, r.status, r.method, r.candidatesFound, r.newCandidates, r.extracted,
       r.failed, r.duplicates, r.error, JSON.stringify(r.outcomes ?? {}), r.note ?? null]
    );
    // WHETHER A SOURCE POLLS IS A PERSON'S DECISION.
    //
    // A successful scan used to switch polling on by itself. It reads as
    // helpful and is not: a source that returns something once has proved it
    // can be read, not that it is worth reading every few hours, and the
    // admin who tested it never asked for it to be added to the schedule.
    // Scanning records what happened; it does not change what the source is.
    //
    // The desk still knows: a scan that brought events back from a source
    // that is not polling says so, and offers the switch (see `couldPoll`).
    const wasSuccess = r.status === 'succeeded';
    const worthPolling = wasSuccess && r.extracted > 0 && !source.polling_enabled;
    await query(
      `update event_sources set last_checked_at = now(),
              last_success_at = case when $2 then now() else last_success_at end,
              failure_count = case when $2 then 0 else failure_count + 1 end,
              events_found = events_found + $3,
              updated_at = now()
        where id = $1`,
      [sourceId, wasSuccess, r.extracted]
    );
    return { scanId, ...r, outcomes: r.outcomes ?? {}, note: r.note ?? null, couldPoll: worthPolling };
  };

  if (!source.active || source.trust === 'blocked') {
    return finish({
      status: 'failed', method: null, candidatesFound: 0, newCandidates: 0,
      extracted: 0, failed: 0, duplicates: 0,
      error: source.trust === 'blocked' ? 'Source is blocked' : 'Source is paused',
    });
  }

  // Prefer a known feed; otherwise the listing page.
  const target = source.feed_url ?? source.url;
  const fetched = await fetcher(target, {
    ...ctx.fetchOptions,
    accept: 'application/rss+xml,application/atom+xml,text/html,application/xhtml+xml,application/xml;q=0.9',
  });
  // Sites that refuse our user agent on their listing page usually still
  // serve their sitemap, which is written for crawlers. Try it before
  // writing the scan off.
  const origin = (() => { try { return new URL(target).origin; } catch { return null; } })();
  const trySitemap = async () => {
    if (!origin) return null;
    await sleep(ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs);
    return findSitemapEvents(origin, fetcher, ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs);
  };

  // This source's ceiling, decided once and used by every reader below.
  const cap = candidateCap(source);
  let method: 'rss' | 'html' | 'sitemap' | 'json';
  let candidates: string[];

  if (!fetched.ok) {
    const sitemap = await trySitemap();
    if (!sitemap) {
      return finish({
        status: 'failed', method: null, candidatesFound: 0, newCandidates: 0,
        extracted: 0, failed: 0, duplicates: 0,
        error: `${fetched.code}: ${fetched.detail}`,
      });
    }
    method = 'sitemap';
    candidates = sitemap.urls;
  } else
  if (looksLikeSitemap(fetched.body)) {
    // The source URL IS a sitemap. Read the event pages straight out of it,
    // stepping into a sitemap index if that is what we were given.
    method = 'sitemap';
    candidates = (await walkSitemap(fetched, fetcher, ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs, cap)).found;
    // The sitemap we were pointed at holds no events. That is the moment the
    // site's OTHER sitemaps matter most — and until now it was the one moment
    // we never asked for them, because asking only happened when the target
    // was not a sitemap in the first place.
    if (!candidates.length && origin) {
      const elsewhere = await findSitemapEvents(
        origin, fetcher, ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs, [target, fetched.finalUrl]
      );
      if (elsewhere?.urls.length) candidates = elsewhere.urls;
    }
  } else
  if (looksLikeFeed(fetched.contentType, fetched.body)) {
    method = 'rss';
    candidates = parseFeedLinks(fetched.body, fetched.finalUrl, cap);
  } else if (looksLikeJson(fetched.body)) {
    // The body decides what it is, not the header: ADE's endpoint calls this
    // text/html and answers with a JSON array of events.
    method = 'json';
    const readJson = (body: string, at: string, asked: string) => identifyJsonLinks(body, at, asked, cap);
    candidates = readJson(fetched.body, fetched.finalUrl, target);
    candidates = await followPages(candidates, target, readJson, fetcher, ctx, cap, deadline);
  } else {
    method = 'html';
    const readHtml = (body: string, at: string, asked: string) => identifyCandidateLinks(body, at, asked, cap);
    candidates = readHtml(fetched.body, fetched.finalUrl, target);
    candidates = await followPages(candidates, target, readHtml, fetcher, ctx, cap, deadline);
    // An advertised feed is a FALLBACK, not an upgrade. Only look at one when
    // the listing page itself yielded nothing: sites routinely advertise a
    // generic blog or news feed, and adopting one while the page was working
    // would permanently redirect every later scan to an empty feed. Gating on
    // an empty page also keeps the probe fetch off the healthy path.
    if (!source.feed_url && candidates.length === 0) {
      const root = parse(fetched.body);
      const feed = root
        .querySelectorAll('link[rel="alternate"]')
        .find((l) => /rss|atom/i.test(l.getAttribute('type') ?? ''))
        ?.getAttribute('href');
      const feedAbs = feed && canonicaliseCandidateUrl(feed, fetched.finalUrl);
      if (feedAbs) {
        await sleep(ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs);
        const probe = await fetcher(feedAbs, {
          ...ctx.fetchOptions,
          accept: 'application/rss+xml,application/atom+xml,application/xml;q=0.9',
        });
        const feedCandidates =
          probe.ok && looksLikeFeed(probe.contentType, probe.body)
            ? parseFeedLinks(probe.body, probe.finalUrl).length
            : 0;
        if (feedCandidates > 0) {
          await query(`update event_sources set feed_url = $2 where id = $1`, [sourceId, feedAbs]);
        }
      }
    }
    // Still nothing on the page — it renders its listings in JavaScript, or
    // its link shapes are unfamiliar. The sitemap is the honest way in.
    if (candidates.length === 0) {
      const sitemap = await trySitemap();
      if (sitemap) {
        method = 'sitemap';
        candidates = sitemap.urls;
      }
    }
  }

  // Which candidates are new for this source?
  const seenRows = candidates.length
    ? await query<{ url: string; extraction_id: string | null }>(
        `select url, extraction_id from source_seen_urls where source_id = $1 and url = any($2)`,
        [sourceId, candidates]
      )
    : [];
  const seenSet = new Set(seenRows.map((r) => r.url));
  const newCandidates = candidates.filter((u) => !seenSet.has(u));

  // SEEN IS NOT PROCESSED. Every candidate is recorded below, but only
  // maxExtractionsPerScan of them run per scan — so eligibility has to mean
  // "no extraction attempted yet", not "never seen before". Keying off seen
  // alone stranded every candidate past the cap forever: they were marked seen
  // on the first scan, counted as old on the next, and never extracted.
  // A URL that already has an extraction (succeeded OR failed) stays skipped;
  // failures are re-run deliberately from the supply log.
  const attempted = new Set(
    seenRows.filter((r) => r.extraction_id !== null).map((r) => r.url)
  );
  // Freshly discovered candidates go first, then the backlog, each in page
  // order. A URL whose extraction threw records no extraction_id and so
  // returns here next scan; putting new links ahead of it keeps one
  // persistently broken page from consuming the whole per-scan budget.
  const pending = [
    ...candidates.filter((u) => !seenSet.has(u)),
    ...candidates.filter((u) => seenSet.has(u) && !attempted.has(u)),
  ];

  for (const url of candidates) {
    await query(
      `insert into source_seen_urls (source_id, url) values ($1, $2)
       on conflict (source_id, url) do update set last_seen_at = now()`,
      [sourceId, url]
    );
  }

  // What it found goes down before any of it is read, for the same reason:
  // a scan that dies during extraction still knows how many links it had.
  await query(
    `update source_scans set candidates_found = $2, new_candidates = $3, method = $4 where id = $1`,
    [scanId, candidates.length, newCandidates.length, method]
  );

  let extracted = 0;
  let failedCount = 0;
  let duplicates = 0;
  const outcomes: OutcomeTally = {};
  const tally = (status: string) => { outcomes[status] = (outcomes[status] ?? 0) + 1; };
  const toProcess = pending.slice(0, supplyConfig.scan.maxExtractionsPerScan);
  // WHAT IT DID NOT GET TO IS PART OF THE ANSWER. A scan stops for two
  // reasons — it ran out of links, or it ran out of time — and the difference
  // is the whole difference between "this source is dry" and "come back".
  let stoppedAt = -1;
  for (let i = 0; i < toProcess.length; i++) {
    if (Date.now() > deadline) { stoppedAt = i; break; }
    if (i > 0) await sleep(ctx.delayMs ?? supplyConfig.scan.delayBetweenFetchesMs);
    try {
      const outcome = await runExtractionPipeline(toProcess[i], {
        sourceId, scanKind: 'source_scan', ai: ctx.ai,
        fetcher: ctx.fetcher, fetchOptions: ctx.fetchOptions,
      });
      await query(
        `update source_seen_urls set extraction_id = $3 where source_id = $1 and url = $2`,
        [sourceId, toProcess[i], outcome.extractionId]
      );
      tally(outcome.status);
      if (outcome.status === 'succeeded' || outcome.status === 'possible_duplicate') extracted++;
      else if (outcome.status === 'duplicate_linked') duplicates++;
      // An event that is already over was read perfectly well; it is in the
      // outcome tally, not counted against the source as a failure.
      else if (outcome.status !== 'event_finished') failedCount++;
    } catch {
      tally('failed');
      failedCount++;
    }
    // PROGRESS IS WRITTEN DOWN AS IT HAPPENS, not only at the end. A scan that
    // is killed part way through has still done real work — the events exist —
    // and the row should say so rather than reporting nothing. It is also what
    // lets the desk show a scan moving instead of a spinner that could mean
    // anything.
    await query(
      `update source_scans set extracted = $2, failed = $3, duplicates = $4,
              outcomes = $5, note = $6 where id = $1`,
      [scanId, extracted, failedCount, duplicates, JSON.stringify(outcomes),
       `${i + 1} of ${toProcess.length} read…`]
    );
  }

  // Anything not attempted this time is still pending next time: it was
  // recorded as seen but carries no extraction_id, so it comes back around.
  const leftOver = stoppedAt >= 0
    ? (toProcess.length - stoppedAt) + (pending.length - toProcess.length)
    : pending.length - toProcess.length;
  const note = stoppedAt >= 0
    ? `Stopped at the time budget after ${stoppedAt} of ${toProcess.length}. ${leftOver} left — scan again to continue.`
    : leftOver > 0
      ? `${leftOver} candidate${leftOver === 1 ? '' : 's'} left for the next scan.`
      : null;

  return finish({
    status: 'succeeded', method,
    candidatesFound: candidates.length, newCandidates: newCandidates.length,
    extracted, failed: failedCount, duplicates, error: null, outcomes, note,
  });
}

// The row the desk watches while a scan runs, shaped exactly like the result
// the scan returns when it finishes — so one renderer draws both.
export async function getScan(scanId: string): Promise<(ScanResult & { running: boolean }) | null> {
  await sweepStaleScans();
  const row = await queryOne<{
    id: string; status: string; method: ScanResult['method'];
    candidates_found: number; new_candidates: number; extracted: number;
    failed: number; duplicates: number; error: string | null;
    outcomes: OutcomeTally | null; note: string | null; polling_enabled: boolean;
  }>(
    `select s.id, s.status, s.method, s.candidates_found, s.new_candidates, s.extracted,
            s.failed, s.duplicates, s.error, s.outcomes, s.note, src.polling_enabled
       from source_scans s join event_sources src on src.id = s.source_id
      where s.id = $1`,
    [scanId]
  );
  if (!row) return null;
  return {
    scanId: row.id,
    running: row.status === 'running',
    status: row.status === 'failed' ? 'failed' : 'succeeded',
    method: row.method,
    candidatesFound: row.candidates_found,
    newCandidates: row.new_candidates,
    extracted: row.extracted,
    failed: row.failed,
    duplicates: row.duplicates,
    error: row.error,
    outcomes: row.outcomes ?? {},
    note: row.note,
    // The same offer the scan itself would have made: this source brought
    // events back and is not on the schedule.
    couldPoll: row.status === 'succeeded' && row.extracted > 0 && !row.polling_enabled,
  };
}

// Scan every source whose polling schedule is due. Designed to be called
// from a cron-hit job endpoint — no browser involved.
export async function scanDueSources(ctx: ScanContext = {}): Promise<{ scanned: number; results: ScanResult[] }> {
  // HOW MANY THE CLOCK CAN ACTUALLY SERVE. Taking twenty sources into a run
  // that has four minutes gives each twelve seconds — not a scan, a gesture.
  // Least-recently-checked first, so a smaller batch still works through
  // every source across successive runs.
  const runBudgetMs = ctx.budgetMs ?? supplyConfig.scan.budgetMs;
  const batch = Math.max(1, Math.min(20, Math.floor(runBudgetMs / supplyConfig.scan.minPerSourceMs)));
  const due = await query<{ id: string }>(
    // Also: the source behind a monthly suggestion that has never been
    // scanned. It is not polling yet — the admin decides that — but they
    // decide by looking at the events it found, so it needs one scan first.
    `select id from event_sources
      where active and trust <> 'blocked'
        and (
          (polling_enabled
            and (last_checked_at is null or last_checked_at < now() - make_interval(hours => poll_frequency_hours)))
          or (last_checked_at is null
            and id in (select source_id from source_suggestions
                        where status = 'pending' and source_id is not null))
        )
      order by last_checked_at asc nulls first
      limit $1`,
    [batch]
  );
  // THE RUN HAS A BUDGET, AND EACH SOURCE GETS A SHARE OF WHAT IS LEFT.
  // Twenty sources at a four-minute ceiling each is eighty minutes, which is
  // longer than anything hosting this will allow — so the run would be killed
  // part way and the sources it never reached would look like they had been
  // scanned. Sharing the clock means every due source gets a real turn, and a
  // slow one cannot eat the whole run. What a source does not finish is still
  // pending for the next one.
  const runDeadline = Date.now() + runBudgetMs;
  const results: ScanResult[] = [];
  for (let i = 0; i < due.length; i++) {
    const left = runDeadline - Date.now();
    if (left <= 0) break;
    try {
      results.push(await scanSource(due[i].id, { ...ctx, budgetMs: Math.floor(left / (due.length - i)) }));
    } catch {
      /* per-source failures are recorded on the scan rows */
    }
  }
  // ONE refresh for the whole run, not one per event. A scan that brings in
  // fifty nights should move the admin's review count once.
  if (results.some((r) => r.extracted > 0)) await refreshAdminReviewDigest();
  return { scanned: results.length, results };
}

// A PAGE THAT BUILDS ITSELF IN THE BROWSER.
//
// "No event links found" is a guess. This is evidence. A client-rendered
// listing ships a recognisable skeleton:
//
//   <ul id="results__list"></ul>            an empty container for the results
//   <div>Loading...</div>                   a placeholder the JS replaces
//   <script type="text/template">            the row template, with !!url!!
//   data-module="…lazy-loading"              the module that fetches them
//
// Amsterdam Dance Event's programme filter has all four. Telling an admin
// "this page loads its listings in the browser" is worth more than telling
// them we found nothing, because it points at the only routes that work: the
// site's sitemap, or a page that renders server-side.
export function looksClientRendered(html: string): boolean {
  let score = 0;
  // A results container that is empty in the HTML we were served.
  if (/<(ul|ol|div)[^>]*\bid=["'][^"']*(results|list|items|events)[^"']*["'][^>]*>\s*<\/(ul|ol|div)>/i.test(html)) score += 2;
  // A template the browser fills in, rather than filled-in markup.
  if (/<script[^>]+type=["']text\/(template|x-template|html)["']/i.test(html)) score += 2;
  // The loader that sits where the results will go.
  if (/\b(id|class)=["'][^"']*(loader|loading|placeholder|skeleton)[^"']*["'][^>]*>\s*(loading|laden|chargement|caricamento)[\s.…]*</i.test(html)) score += 1;
  // The module that will do the fetching.
  if (/data-module=["'][^"']*(lazy|infinite|load-more|filter-page)[^"']*["']/i.test(html)) score += 1;
  return score >= 3;
}
