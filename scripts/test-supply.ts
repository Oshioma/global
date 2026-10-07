// Deterministic tests for the Event Supply Engine (V2A).
// No live websites, no live AI: fixtures + injected fetcher + mock AI
// clients, against the local database (freshly reset + seeded).
//
// Usage: npm run test:supply   (runs db reset + seed itself)

import { execSync } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { gzipSync, brotliCompressSync, deflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';

// Load .env.local like the app does.
const root = path.resolve(__dirname, '..');
if (existsSync(path.join(root, '.env.local'))) {
  for (const line of readFileSync(path.join(root, '.env.local'), 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

console.log('Resetting + seeding database…');
execSync('node scripts/migrate.mjs --reset && node scripts/seed.mjs', { cwd: root, stdio: 'ignore' });

import { validateUrl, safeFetch, isBlockedIPv4, isBlockedIPv6, type SafeFetchResult, type SafeFetchOptions } from '@/lib/supply/safeFetch';
import { inspectPage, cleanPageText } from '@/lib/supply/structured';
import { parseAIJson, validateAIProposal, type AIExtractionClient, type AIExtractionOutcome } from '@/lib/supply/ai';
import { zonedTimeToUtc, parseLocalInTimezone, parseFoundDate, resolveEndCrossingMidnight, inferTimezone } from '@/lib/supply/time';
import { mapGenreProposals, loadGenres } from '@/lib/supply/genres';
import { computeOverallConfidence, canAutoPublish } from '@/lib/supply/confidence';
import { runExtractionPipeline } from '@/lib/supply/pipeline';
import { scanSource, getScan, startScan, sweepStaleScans, candidateCap, nextPageUrl, isPaged, identifyJsonLinks, looksLikeJson, identifyCandidateLinks, identifyEmbeddedLinks, isFacetOfPage, pageFilterLinks, parseFeedLinks, canonicaliseCandidateUrl, countSitemapUrls, sitemapEventUrls, sitemapIndexUrls, sitemapsFromRobots } from '@/lib/supply/scanner';
import { explainScan, outcomeLabel } from '@/lib/supply/outcomes';
import { discoverSources, normaliseCandidates, isBannedCandidateHost, buildDiscoveryUser, DISCOVERY_SYSTEM_PROMPT, type DiscoveryClient } from '@/lib/supply/discover';
import { matchGenreIdsByName } from '@/lib/util';
import { canonicalCountry, countrySlug } from '@/lib/countries';
import { pickPageImage, findPageImages, largestInSrcset, backgroundImageUrl } from '@/lib/supply/images';
import { canonicalCity, isCanonicalCity } from '@/lib/cityNames';
import { looksClientRendered } from '@/lib/supply/scanner';
import { isLiveSource } from '@/lib/supply/health';
import { findListingLink, previewBody } from '@/lib/supply/probe';
import { testVerdict, type ProbeResult } from '@/lib/supply/verdict';
import { purgeFinishedUnpublished, publishQueue } from '@/lib/adminEvents';
import { pollSuggestion, dismissSuggestion } from '@/lib/supply/suggest';
import { heldForSuggestionSql } from '@/lib/adminEvents';
import { runMonthlySuggestions, bucketGenres, probePassed, suggestionsEmail, hostOf } from '@/lib/supply/suggest';
import { fetcherFor, renderingConfigured } from '@/lib/supply/render';
import { parse } from 'node-html-parser';
import { readRetreatLink, looksGenerated } from '@/lib/retreats';

const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const q = (text: string, params: unknown[] = []) => db.query(text, params).then((r) => r.rows);

let passed = 0;
let failed = 0;
const failures: string[] = [];
function check(name: string, cond: unknown, extra = '') {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name} ${extra}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const FUTURE = new Date(Date.now() + 40 * 86400_000);
const futureDate = FUTURE.toISOString().slice(0, 10); // YYYY-MM-DD

const JSONLD_PAGE = (opts: {
  title?: string; startDate?: string; endDate?: string | null; venue?: string;
  city?: string; ticketUrl?: string | null; image?: string | null; canonical?: string | null;
} = {}) => `<!doctype html><html><head>
<title>${opts.title ?? 'Warehouse Frequencies'} | Promoter</title>
${opts.canonical ? `<link rel="canonical" href="${opts.canonical}">` : ''}
<meta property="og:title" content="OG ${opts.title ?? 'Warehouse Frequencies'}">
<meta property="og:image" content="https://cdn.promoter-a.example/og.jpg">
<script type="application/ld+json">
${JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'MusicEvent',
  name: opts.title ?? 'Warehouse Frequencies',
  startDate: opts.startDate ?? `${futureDate}T22:00:00+01:00`,
  ...(opts.endDate === null ? {} : { endDate: opts.endDate ?? `${futureDate}T23:30:00+01:00` }),
  image: opts.image === null ? undefined : (opts.image ?? 'https://cdn.promoter-a.example/artwork.jpg'),
  location: {
    '@type': 'Place',
    name: opts.venue ?? 'The Pressing Plant',
    address: {
      '@type': 'PostalAddress',
      streetAddress: '4 Vinyl Way',
      addressLocality: opts.city ?? 'London',
      addressCountry: 'United Kingdom',
    },
  },
  performer: [{ '@type': 'MusicGroup', name: 'Fixture Artist One' }, { '@type': 'MusicGroup', name: 'Fixture Artist Two' }],
  organizer: { '@type': 'Organization', name: 'Fixture Promotions', url: 'https://promoter-a.example' },
  offers: { '@type': 'Offer', url: opts.ticketUrl === null ? undefined : (opts.ticketUrl ?? 'https://tickets.example/checkout/wf'), price: '17.50', priceCurrency: 'GBP' },
})}
</script></head>
<body><nav>Home Events About</nav><main><h1>${opts.title ?? 'Warehouse Frequencies'}</h1>
<p>Proper techno all night long. Doors 22:00.</p></main>
<footer>© Promoter</footer></body></html>`;

const OG_ONLY_PAGE = `<!doctype html><html><head>
<title>Sundown Sessions — tickets</title>
<meta property="og:title" content="Sundown Sessions">
<meta property="og:description" content="Balearic afternoon on the terrace.">
<meta property="og:image" content="https://cdn.promoter-b.example/sundown.jpg">
</head><body>
<nav><a href="/">Home</a><a href="/about">About</a></nav>
<main><h1>Sundown Sessions</h1>
<p>Saturday ${futureDate}, 3pm until 10pm at Harbour Terrace, Bristol.</p>
<p>Balearic and disco all afternoon. Tickets £12.</p>
<a href="https://tickets.example/checkout/sundown">Buy tickets</a></main>
<footer>Cookie banner. Privacy. Terms.</footer></body></html>`;

const LISTING_PAGE = `<!doctype html><html><head><title>Promoter A — What's on</title>
<link rel="alternate" type="application/rss+xml" href="/feed.xml"></head><body>
<nav><a href="/about">About</a><a href="/login">Login</a></nav>
<main>
<a href="/events/warehouse-frequencies?utm_source=home">Warehouse Frequencies — ${futureDate}</a>
<a href="/events/second-night#top">Second Night</a>
<a href="/events/warehouse-frequencies">Warehouse Frequencies duplicate anchor</a>
<a href="https://other-site.example/events/away-day">Away day (offsite event link)</a>
<a href="/news/some-article">Some article</a>
<a href="/privacy">Privacy</a>
</main></body></html>`;

const RSS_FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
<title>Promoter B feed</title>
<item><title>Feed Night One</title><link>https://promoter-b.example/events/feed-night-one</link></item>
<item><title>Feed Night Two</title><link>https://promoter-b.example/events/feed-night-two</link></item>
</channel></rss>`;

// ---------------------------------------------------------------------------
// Mock fetcher + mock AI
// ---------------------------------------------------------------------------

type FixtureResponse = { body: string; contentType?: string; finalUrl?: string };
function mockFetcher(map: Record<string, FixtureResponse>) {
  return async (url: string): Promise<SafeFetchResult> => {
    // Real URL validation still applies in front of the fixture map.
    const validated = validateUrl(url);
    if (!validated.ok) return { ...validated, ms: 1 };
    const hit = map[url];
    if (!hit) return { ok: false, code: 'not_found', detail: 'fixture 404', status: 404, ms: 1 };
    return {
      ok: true, status: 200, finalUrl: hit.finalUrl ?? url,
      contentType: hit.contentType ?? 'text/html; charset=utf-8', body: hit.body, ms: 1,
    };
  };
}

function mockAI(proposals: Record<string, unknown>, opts: { raw?: Record<string, string> } = {}): AIExtractionClient {
  return {
    available: true,
    async extract({ url }): Promise<AIExtractionOutcome> {
      if (opts.raw && url in opts.raw) {
        const parsed = parseAIJson(opts.raw[url]);
        if (parsed == null) return { ok: false, error: 'invalid_json', detail: 'Model output was not parseable JSON' };
        const v = validateAIProposal(parsed);
        if (!v.ok) return { ok: false, error: 'invalid_shape', detail: v.detail };
        return { ok: true, proposal: v.proposal, model: 'mock', inputTokens: 1000, outputTokens: 200 };
      }
      const p = proposals[url] ?? proposals.default;
      if (!p) return { ok: false, error: 'call_failed', detail: 'no fixture proposal' };
      const v = validateAIProposal(p);
      if (!v.ok) return { ok: false, error: 'invalid_shape', detail: v.detail };
      return { ok: true, proposal: v.proposal, model: 'mock', inputTokens: 1000, outputTokens: 200 };
    },
  };
}

const noAI: AIExtractionClient = {
  available: false,
  async extract() {
    return { ok: false, error: 'unavailable', detail: 'mock: no key' };
  },
};

const baseProposal = {
  is_event: true, is_music_event: true,
  genres: [
    { name: 'Techno', confidence: 95 },
    { name: 'liquid funk', confidence: 80 },
  ],
  event_type: 'club_night',
  field_confidence: { title: 90, date: 90, venue: 88, city: 88, genres: 92 },
};

async function main() {
  await db.connect();

  // -------------------------------------------------------------------------
  console.log('\n— URL validation / SSRF —');
  {
    const cases: [string, string][] = [
      ['http://localhost/admin', 'localhost'],
      ['http://127.0.0.1:8080/x', 'loopback IP'],
      ['http://10.0.0.5/internal', 'private 10/8'],
      ['http://192.168.1.10/', 'private 192.168/16'],
      ['http://172.16.9.1/', 'private 172.16/12'],
      ['http://169.254.169.254/latest/meta-data/', 'cloud metadata IP'],
      ['http://metadata.google.internal/computeMetadata/', 'metadata hostname'],
      ['http://[::1]/x', 'IPv6 loopback'],
      ['http://[fd12::1]/x', 'IPv6 unique-local'],
      ['http://[::ffff:127.0.0.1]/x', 'IPv4-mapped loopback'],
      ['http://foo.internal/x', '.internal suffix'],
      ['http://user:pass@promoter.example/x', 'credentials in URL'],
    ];
    for (const [url, label] of cases) {
      const r = validateUrl(url);
      check(`rejects ${label}`, !r.ok && (r as { code: string }).code !== undefined);
    }
    check('rejects ftp protocol', !validateUrl('ftp://promoter.example/x').ok);
    check('rejects garbage', !validateUrl('not a url').ok);
    check('accepts public https', validateUrl('https://promoter.example/events/night').ok);
    check('blocks 100.64/10 CGNAT', isBlockedIPv4('100.64.0.1'));
    check('blocks NAT64-embedded private', isBlockedIPv6('64:ff9b::a00:1'.replace('a00:1', '10.0.0.1')) || isBlockedIPv6('64:ff9b::10.0.0.1'));
    check('allows public IPv4', !isBlockedIPv4('93.184.216.34'));
  }

  // -------------------------------------------------------------------------
  console.log('\n— safeFetch hardening (local fixture server) —');
  {
    let slowTimer: NodeJS.Timeout | null = null;
    const server: Server = createServer((req, res) => {
      switch (req.url) {
        case '/redirect-private':
          res.writeHead(302, { Location: 'http://169.254.169.254/latest/' }).end();
          break;
        case '/redirect-localhost':
          res.writeHead(302, { Location: 'http://localhost/secret' }).end();
          break;
        case '/redirect-loop':
          res.writeHead(302, { Location: '/redirect-loop' }).end();
          break;
        case '/big-declared':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '99999999' });
          res.write('<html>');
          break;
        case '/big-streamed': {
          res.writeHead(200, { 'Content-Type': 'text/html' });
          const chunk = 'x'.repeat(65536);
          for (let i = 0; i < 40; i++) res.write(chunk);
          res.end();
          break;
        }
        case '/slow':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          slowTimer = setTimeout(() => res.end('<html>late</html>'), 5000);
          break;
        case '/png':
          res.writeHead(200, { 'Content-Type': 'image/png' }).end('not really a png');
          break;
        case '/missing':
          res.writeHead(404).end();
          break;
        case '/forbidden':
          res.writeHead(403).end();
          break;
        case '/ok':
          res.writeHead(200, { 'Content-Type': 'text/html' }).end('<html><title>ok</title></html>');
          break;
        // A CDN handing back a compressed variant. Read as UTF-8 this is a
        // page of mojibake with no links in it — HTTP 200, right size,
        // nothing found — which is indistinguishable from an empty site.
        case '/gzipped':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
            .end(gzipSync(Buffer.from('<html><a href="/events/gzip-night">Gzip Night</a></html>')));
          break;
        case '/brotli':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'br' })
            .end(brotliCompressSync(Buffer.from('<html><a href="/events/br-night">Brotli Night</a></html>')));
          break;
        case '/deflated':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'deflate' })
            .end(deflateSync(Buffer.from('<html><title>deflated</title></html>')));
          break;
        case '/identity':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'identity' })
            .end('<html><title>plain</title></html>');
          break;
        case '/lying':
          // Says gzip, is not. A broken stream must be reported, never handed
          // on as text for the rest of the pipeline to find nothing in.
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
            .end('<html>not actually compressed</html>');
          break;
        case '/bomb':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
            .end(gzipSync(Buffer.alloc(4_000_000, 0x61)));
          break;
        default:
          res.writeHead(500).end();
      }
    });
    await new Promise<void>((r) => server.listen(4571, '127.0.0.1', r));
    const T = (p: string) => `http://127.0.0.1:4571${p}`;
    const opts: SafeFetchOptions = { allowHostsForTests: ['127.0.0.1'], timeoutMs: 1500, maxBytes: 1_000_000 };

    const ok = await safeFetch(T('/ok'), opts);
    check('fetches allowed fixture host', ok.ok && ok.body.includes('ok'));
    const rp = await safeFetch(T('/redirect-private'), opts);
    check('redirect to private IP rejected', !rp.ok && rp.code === 'unsafe_url');
    const rl = await safeFetch(T('/redirect-localhost'), opts);
    check('redirect to localhost rejected', !rl.ok && rl.code === 'unsafe_url');
    const loop = await safeFetch(T('/redirect-loop'), opts);
    check('redirect loop capped', !loop.ok && loop.code === 'fetch_failed');
    const bigD = await safeFetch(T('/big-declared'), opts);
    check('declared oversize rejected', !bigD.ok && bigD.code === 'too_large');
    const bigS = await safeFetch(T('/big-streamed'), opts);
    check('streamed oversize rejected', !bigS.ok && bigS.code === 'too_large');
    const slow = await safeFetch(T('/slow'), opts);
    check('timeout enforced', !slow.ok && slow.code === 'fetch_failed' && /Timed out/i.test(slow.detail));
    const png = await safeFetch(T('/png'), opts);
    check('non-HTML content-type rejected', !png.ok && png.code === 'unsupported_content');
    const nf = await safeFetch(T('/missing'), opts);
    check('404 → not_found', !nf.ok && nf.code === 'not_found');
    const fb = await safeFetch(T('/forbidden'), opts);
    check('403 → blocked_by_site (no anti-bot escalation)', !fb.ok && fb.code === 'blocked_by_site');
    check('localhost blocked WITHOUT test allowlist', !(await safeFetch(T('/ok'))).ok);

    // COMPRESSED RESPONSES. We ask for them now, so we had better be able to
    // read them — and a CDN will hand one over whether we asked or not.
    const gz = await safeFetch(T('/gzipped'), opts);
    check('a gzipped page is read, not handed on as mojibake',
      gz.ok && gz.body.includes('Gzip Night'), gz.ok ? gz.body.slice(0, 60) : gz.detail);
    const br = await safeFetch(T('/brotli'), opts);
    check('a brotli page is read too — the shape ADE serves',
      br.ok && br.body.includes('Brotli Night'), br.ok ? br.body.slice(0, 60) : br.detail);
    const df = await safeFetch(T('/deflated'), opts);
    check('deflate is read', df.ok && df.body.includes('deflated'));
    const id = await safeFetch(T('/identity'), opts);
    check('an identity encoding is left alone', id.ok && id.body.includes('plain'));
    const lying = await safeFetch(T('/lying'), opts);
    check('a body that lies about its encoding fails loudly',
      !lying.ok && lying.code === 'fetch_failed' && /decompress/i.test(lying.detail),
      JSON.stringify(lying));
    const bomb = await safeFetch(T('/bomb'), opts);
    check('a small response that expands past the cap is stopped',
      !bomb.ok && bomb.code === 'too_large', JSON.stringify(bomb));
    if (slowTimer) clearTimeout(slowTimer);
    server.close();
  }

  // -------------------------------------------------------------------------
  console.log('\n— structured metadata parsing —');
  {
    const url = 'https://promoter-a.example/events/warehouse-frequencies';
    const page = inspectPage(JSONLD_PAGE({ canonical: url }), url);
    check('JSON-LD title (beats OG)', page.title?.value === 'Warehouse Frequencies' && page.title.source === 'json-ld');
    check('JSON-LD start date', page.startAt?.value === `${futureDate}T22:00:00+01:00`);
    check('JSON-LD venue + city + country', page.venueName?.value === 'The Pressing Plant' && page.city?.value === 'London' && page.country?.value === 'United Kingdom');
    check('JSON-LD performers', page.performers.length === 2 && page.performers[0] === 'Fixture Artist One');
    check('JSON-LD offer → ticket URL separated from source', page.ticketUrl?.value === 'https://tickets.example/checkout/wf');
    check('JSON-LD price + currency', page.priceFrom?.value === 17.5 && page.currency?.value === 'GBP');
    check('JSON-LD image preferred over OG', page.imageUrl?.value === 'https://cdn.promoter-a.example/artwork.jpg');
    check('canonical URL captured', page.canonicalUrl === url);
    check('organizer captured', page.organizerName?.value === 'Fixture Promotions');
    check('structured data flag set', page.structuredDataFound);

    // schema.org genre + eventStatus (common on real event pages).
    const gPage = inspectPage(
      `<html><head><script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Tagged Night',
        startDate: `${futureDate}T21:00:00+01:00`,
        genre: ['Drum & Bass / Jungle', 'Liquid Funk'],
        eventStatus: 'https://schema.org/EventCancelled',
        location: { '@type': 'Place', name: 'Tag Hall', address: { addressLocality: 'Leeds', addressCountry: 'United Kingdom' } },
      })}</script></head><body><main>x</main></body></html>`,
      'https://promoter-g.example/events/tagged'
    );
    check('JSON-LD genre parsed and split', gPage.genres.includes('Drum & Bass') && gPage.genres.includes('Jungle') && gPage.genres.includes('Liquid Funk'));
    check('schema.org eventStatus → cancelled hint', gPage.eventStatusHint === 'cancelled');

    const og = inspectPage(OG_ONLY_PAGE, 'https://promoter-b.example/events/sundown');
    check('OpenGraph fallback title', og.title?.value === 'Sundown Sessions' && og.title.source === 'opengraph');
    check('no structured Event flagged', !og.structuredDataFound);
    check('cleaned text keeps content', og.cleanedText.includes('Balearic and disco'));
    check('cleaned text strips nav/footer', !og.cleanedText.includes('Cookie banner') && !/Home\s*About/.test(og.cleanedText.split('\n')[0] ?? ''));
    const stripped = cleanPageText(parse('<html><body><script>var x=1;</script><nav>MENU</nav><main>real content here</main></body></html>'), 5000);
    check('scripts stripped from AI content', !stripped.includes('var x') && stripped.includes('real content'));
  }

  // -------------------------------------------------------------------------
  console.log('\n— date/time normalisation —');
  {
    const summer = zonedTimeToUtc(2026, 7, 10, 22, 0, 'Europe/London');
    check('BST wall clock → UTC-1h', summer.toISOString() === '2026-07-10T21:00:00.000Z');
    const winter = zonedTimeToUtc(2026, 1, 10, 22, 0, 'Europe/London');
    check('GMT wall clock → UTC same', winter.toISOString() === '2026-01-10T22:00:00.000Z');
    const local = parseLocalInTimezone('2026-07-10T22:00', 'Europe/Berlin');
    check('datetime-local parsed in event tz (Berlin)', local?.toISOString() === '2026-07-10T20:00:00.000Z');
    const start = zonedTimeToUtc(2026, 7, 10, 23, 0, 'Europe/London');
    const endSameNight = zonedTimeToUtc(2026, 7, 10, 4, 0, 'Europe/London');
    const rolled = resolveEndCrossingMidnight(start, endSameNight);
    check('midnight crossing rolls end +1 day', rolled.getTime() - start.getTime() === 5 * 3600_000);
    const offsetParsed = parseFoundDate('2026-08-01T21:00:00+02:00', 'Europe/London');
    check('explicit offset honoured over tz', offsetParsed?.date.toISOString() === '2026-08-01T19:00:00.000Z');
    const dateOnly = parseFoundDate('2026-08-01', 'Europe/Madrid');
    check('date-only flagged', dateOnly?.dateOnly === true);
    check('invalid date rejected', parseFoundDate('next friday probably', 'Europe/London') === null);
    check('tz inferred from country', inferTimezone('Spain').timezone === 'Europe/Madrid');
    check('invalid explicit tz falls through', inferTimezone('Germany', 'Not/AZone').timezone === 'Europe/Berlin');
  }

  // -------------------------------------------------------------------------
  console.log('\n— genre mapping —');
  {
    const taxonomy = await loadGenres();
    const m = mapGenreProposals(
      [
        { name: 'liquid funk', confidence: 90 },
        { name: 'Drum & Bass', confidence: 97 },
        { name: 'UKG', confidence: 70 },
        { name: 'zydeco', confidence: 66 },
        { name: 'electronic', confidence: 50 },
      ],
      taxonomy
    );
    const slugs = m.matched.map((x) => x.genre.slug);
    check('"liquid funk" maps to Liquid subgenre', slugs.includes('liquid'));
    check('subgenre implies parent Drum & Bass', slugs.includes('drum-and-bass'));
    check('alias UKG → UK Garage (+ parent Garage)', slugs.includes('uk-garage') && slugs.includes('garage'));
    check('unknown genre goes to suggestions, not created', m.unknown.length === 1 && m.unknown[0].name === 'zydeco');
    check('generic "electronic" ignored silently', !m.unknown.some((u) => u.name === 'electronic'));
    check('exact name match works', mapGenreProposals([{ name: 'Techno', confidence: 90 }], taxonomy).matched.some((x) => x.genre.slug === 'techno'));
    const dab = mapGenreProposals([{ name: 'D&B', confidence: 90 }], taxonomy);
    check('"D&B" alias maps to Drum & Bass', dab.matched.some((x) => x.genre.slug === 'drum-and-bass'));
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: structured genres + eventStatus without AI —');
  {
    const urlT = 'https://promoter-g.example/events/tagged-no-ai';
    const body = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Tagged No-AI Night',
      startDate: `${futureDate}T21:00:00+01:00`,
      genre: 'Drum & Bass / Jungle',
      location: { '@type': 'Place', name: 'Tag Hall', address: { '@type': 'PostalAddress', addressLocality: 'Leeds', addressCountry: 'United Kingdom' } },
      offers: { '@type': 'Offer', url: 'https://tickets.example/tagged' },
    })}</script></head><body><main>Tagged</main></body></html>`;
    const out = await runExtractionPipeline(urlT, { fetcher: mockFetcher({ [urlT]: { body } }), ai: noAI });
    check('LD genres classify the event without AI', out.status === 'succeeded');
    const gn = await q(
      `select g.slug from event_genres eg join genres g on g.id = eg.genre_id where eg.event_id = $1`,
      [out.eventId]
    );
    const slugs = (gn as { slug: string }[]).map((x) => x.slug);
    check('LD genre split maps to taxonomy', slugs.includes('drum-and-bass') && slugs.includes('jungle'));
    const ex1 = (await q(`select field_sources, relevance from extractions where event_id = $1`, [out.eventId]))[0] as {
      field_sources: Record<string, string>; relevance: string;
    };
    check('genre provenance = json-ld', ex1.field_sources.genres === 'json-ld');
    check('relevance decided from structured genres', ex1.relevance === 'relevant');

    const urlC = 'https://promoter-g.example/events/cancelled-on-page';
    const bodyC = body
      .replace('Tagged No-AI Night', 'Cancelled On Page')
      .replace('"genre":"Drum & Bass / Jungle"', '"genre":"Techno","eventStatus":"https://schema.org/EventCancelled"')
      .replace('tickets.example/tagged', 'tickets.example/cancelled-x');
    const outC = await runExtractionPipeline(urlC, { fetcher: mockFetcher({ [urlC]: { body: bodyC } }), ai: noAI });
    const evC = (await q(`select listing_status from events where id = $1`, [outC.eventId]))[0] as { listing_status: string };
    check('page-declared cancellation carried onto draft', evC.listing_status === 'cancelled');
  }

  // -------------------------------------------------------------------------
  console.log('\n— deterministic confidence + auto-publish gate —');
  {
    const fields = { title: 97, date: 96, venue: 94, city: 92, genres: 92, lineup: 90, image: 92, ticket_url: 92 };
    const trusted = computeOverallConfidence(fields, 'trusted');
    const untrusted = computeOverallConfidence(fields, 'new');
    check('overall computed deterministically', trusted > 90 && trusted <= 100);
    check('source trust scales confidence', untrusted < trusted);
    check('no date → zero confidence', computeOverallConfidence({ title: 99 }, 'trusted') === 0);
    const base = {
      sourceTrust: 'trusted', overallConfidence: trusted, fieldConfidence: fields,
      startAt: FUTURE, hasLocation: true, mappedGenreCount: 2,
      duplicateState: 'none' as const, warnings: [],
    };
    check('clean trusted extraction may auto-publish', canAutoPublish(base).ok);
    check('NEW source never auto-publishes', !canAutoPublish({ ...base, sourceTrust: 'new' }).ok);
    check('duplicate blocks auto-publish', !canAutoPublish({ ...base, duplicateState: 'possible' }).ok);
    check('past event blocks auto-publish', !canAutoPublish({ ...base, startAt: new Date(Date.now() - 86400_000) }).ok);
    check('timezone warning blocks auto-publish', !canAutoPublish({ ...base, warnings: ['timezone assumed Europe/London (no location evidence)'] }).ok);
  }

  // -------------------------------------------------------------------------
  console.log('\n— AI response robustness —');
  {
    check('parses fenced JSON', (parseAIJson('```json\n{"is_event":true}\n```') as { is_event: boolean }).is_event === true);
    check('salvages JSON with prose around it', (parseAIJson('Sure! {"is_event":false} hope that helps') as { is_event: boolean }).is_event === false);
    check('malformed JSON → null', parseAIJson('deeply sorry, no json today') === null);
    check('wrong shape rejected', !validateAIProposal({ is_event: 'yes' }).ok);
    check('injection-shaped fields rejected by schema', !validateAIProposal({ is_event: true, genres: [{ name: 'x'.repeat(500), confidence: 90 }] }).ok);
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: structured-first extraction —');
  const urlA = 'https://promoter-a.example/events/warehouse-frequencies';
  {
    const fetcher = mockFetcher({ [urlA]: { body: JSONLD_PAGE({ canonical: urlA }) } });
    const out = await runExtractionPipeline(urlA, { fetcher, ai: mockAI({ default: baseProposal }) });
    check('JSON-LD pipeline succeeds', out.status === 'succeeded' && !!out.eventId);
    const ev = (await q(
      `select e.*, (select count(*)::int from event_genres g where g.event_id = e.id) as genre_count,
              (select count(*)::int from event_artists a where a.event_id = e.id) as artist_count
         from events e where e.id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('title from JSON-LD', ev.title === 'Warehouse Frequencies');
    check('start stored with explicit offset (21:00Z)', new Date(ev.start_at as string).toISOString().includes('21:00:00'));
    check('end time preserved, not invented', ev.end_at != null);
    check('ticket URL separated from source URL', ev.ticket_url === 'https://tickets.example/checkout/wf' && ev.source_url === urlA);
    check('canonical URL stored', ev.canonical_url === urlA);
    check('price captured', Number(ev.price_from) === 17.5 && ev.currency === 'GBP');
    check('image from JSON-LD', ev.primary_image_url === 'https://cdn.promoter-a.example/artwork.jpg');
    check('multiple genres m2m (techno + liquid + dnb)', (ev.genre_count as number) >= 3);
    check('lineup created', (ev.artist_count as number) === 2);
    check('draft not live (no trusted source)', ev.status !== 'live');
    check('confidence stored on event', ev.confidence_score != null);
    const ex = (await q(`select * from extractions where event_id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('provenance recorded (title=json-ld)', (ex.field_sources as Record<string, string>).title === 'json-ld');
    check('metrics recorded (ai tokens, timings)', ex.ai_used === true && ex.ai_input_tokens === 1000 && ex.total_ms != null);
    check('structured-data hit recorded', ex.structured_data_found === true);
    const links = await q(`select * from event_source_links where event_id = $1`, [out.eventId]);
    check('source link evidence created', links.length === 1);
    const venue = (await q(`select name, city from venues where id = $1`, [ev.venue_id]))[0] as { name: string };
    check('venue created from JSON-LD place', venue?.name === 'The Pressing Plant');
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: exact URL duplicate + multi-source enrichment —');
  {
    // Same canonical event discovered via a different URL that redirects/serves
    // the same canonical link → exact duplicate → linked, not duplicated.
    const urlA2 = 'https://venue-site.example/whats-on/warehouse-frequencies';
    const fetcher = mockFetcher({
      [urlA2]: { body: JSONLD_PAGE({ canonical: urlA }) }, // same canonical
    });
    const out = await runExtractionPipeline(urlA2, { fetcher, ai: mockAI({ default: baseProposal }) });
    check('exact duplicate → linked, no new event', out.status === 'duplicate_linked');
    const events = await q(`select id from events where title = 'Warehouse Frequencies'`);
    check('still exactly one canonical event', events.length === 1);
    const links = await q(`select url, kind from event_source_links where event_id = $1 order by created_at`, [out.duplicateOf]);
    check('event now carries multiple source links', links.length === 2);

    // Resubmitting the identical URL is also an exact duplicate.
    const again = await runExtractionPipeline(urlA, {
      fetcher: mockFetcher({ [urlA]: { body: JSONLD_PAGE({ canonical: urlA }) } }),
      ai: mockAI({ default: baseProposal }),
    });
    check('same URL twice → duplicate, not second event', again.status === 'duplicate_linked');
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: probable (non-URL) duplicate —');
  {
    const urlDup = 'https://blog.example/events/warehouse-frequencies-preview';
    const fetcher = mockFetcher({
      [urlDup]: { body: JSONLD_PAGE({ canonical: urlDup, venue: 'Pressing Plant', ticketUrl: null }) },
    });
    const out = await runExtractionPipeline(urlDup, { fetcher, ai: mockAI({ default: baseProposal }) });
    check('similar title+date+city → flagged, not merged', out.status === 'possible_duplicate' && !!out.eventId);
    const ev = (await q(`select status, possible_duplicate_of from events where id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('flagged draft goes to needs_review', ev.status === 'needs_review');
    check('duplicate pointer set for admin', ev.possible_duplicate_of != null);
    const ex = (await q(`select duplicate_state, duplicate_score from extractions where event_id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('duplicate scored (possible/likely)', ['possible', 'likely'].includes(ex.duplicate_state as string) && Number(ex.duplicate_score) >= 50);
    // Clean up flagged draft so later scans aren't affected.
    await q(`update events set status = 'rejected' where id = $1`, [out.eventId]);
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: AI-assisted extraction (no structured data) —');
  const urlB = 'https://promoter-b.example/events/sundown';
  {
    const proposal = {
      is_event: true, is_music_event: true,
      title: 'Sundown Sessions',
      start_date: futureDate, start_time: '15:00', end_time: '22:00',
      venue_name: 'Paradise Wharf', city: 'Bristol', country: 'United Kingdom',
      artists: ['The Vinyl Gardener'],
      genres: [{ name: 'Balearic', confidence: 90 }, { name: 'nu disco', confidence: 84 }],
      event_type: 'day_party',
      ticket_url: 'https://tickets.example/checkout/sundown',
      price_from: 12, currency: 'GBP',
      field_confidence: { title: 88, date: 85, start_time: 80, venue: 82, city: 85, genres: 88 },
    };
    const out = await runExtractionPipeline(urlB, {
      fetcher: mockFetcher({ [urlB]: { body: OG_ONLY_PAGE } }),
      ai: mockAI({ [urlB]: proposal }),
    });
    check('AI-assisted extraction succeeds', out.status === 'succeeded' && !!out.eventId);
    const ev = (await q(`select * from events where id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('OG title kept (structured beats AI)', ev.title === 'Sundown Sessions');
    const startIso = new Date(ev.start_at as string).toISOString();
    const expectedStart = zonedTimeToUtc(
      Number(futureDate.slice(0, 4)), Number(futureDate.slice(5, 7)), Number(futureDate.slice(8, 10)),
      15, 0, 'Europe/London'
    ).toISOString();
    check('AI local time interpreted in event tz', startIso === expectedStart);
    check('same-day end resolved (15:00→22:00)', new Date(ev.end_at as string).getTime() - new Date(ev.start_at as string).getTime() === 7 * 3600_000);
    const venue = (await q(`select id, name from venues where id = $1`, [ev.venue_id]))[0] as { id: string; name: string };
    const seededVenue = (await q(`select id from venues where slug = 'paradise-wharf'`))[0] as { id: string };
    check('existing venue reused, not duplicated', venue.id === seededVenue.id);
    const venueCount = await q(`select count(*)::int as n from venues where lower(name) like 'paradise wharf%'`);
    check('no venue formatting duplicates', (venueCount[0] as { n: number }).n === 1);
    const ex = (await q(`select field_sources from extractions where event_id = $1`, [out.eventId]))[0] as { field_sources: Record<string, string> };
    check('AI provenance recorded for date', ex.field_sources.date === 'ai');
    check('entity-match provenance for venue', ex.field_sources.venue === 'entity-match');
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: midnight crossing + multi-day festival —');
  {
    const urlNight = 'https://promoter-c.example/events/all-nighter';
    const nightProposal = {
      is_event: true, is_music_event: true, title: 'All Nighter',
      start_date: futureDate, start_time: '23:00', end_time: '06:00',
      city: 'Leeds', country: 'United Kingdom',
      genres: [{ name: 'Jungle', confidence: 92 }],
      field_confidence: { title: 85, date: 85, city: 80, genres: 90 },
    };
    const out1 = await runExtractionPipeline(urlNight, {
      fetcher: mockFetcher({ [urlNight]: { body: '<html><title>All Nighter</title><body><main>All Nighter</main></body></html>' } }),
      ai: mockAI({ [urlNight]: nightProposal }),
    });
    const ev1 = (await q(`select start_at, end_at from events where id = $1`, [out1.eventId]))[0] as Record<string, string>;
    check('midnight crossing: end rolls to next day', new Date(ev1.end_at).getTime() - new Date(ev1.start_at).getTime() === 7 * 3600_000);

    const festStart = `${futureDate}T12:00:00+01:00`;
    const festEndDate = new Date(FUTURE.getTime() + 2 * 86400_000).toISOString().slice(0, 10);
    const urlFest = 'https://festival.example/events/three-dayer';
    const out2 = await runExtractionPipeline(urlFest, {
      fetcher: mockFetcher({
        [urlFest]: { body: JSONLD_PAGE({ title: 'Three Dayer Festival', startDate: festStart, endDate: `${festEndDate}T23:00:00+01:00`, venue: 'Festival Field', city: 'Norwich', canonical: urlFest, ticketUrl: 'https://tickets.example/fest' }) },
      }),
      ai: mockAI({ default: { ...baseProposal, event_type: 'festival' } }),
    });
    const ev2 = (await q(`select start_at, end_at, event_type from events where id = $1`, [out2.eventId]))[0] as Record<string, string>;
    const spanDays = (new Date(ev2.end_at).getTime() - new Date(ev2.start_at).getTime()) / 86400_000;
    check('multi-day festival span preserved', spanDays > 1.9 && spanDays < 2.6);
    check('festival type from JSON-LD subtype', ev2.event_type === 'festival');
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: honest gaps (no invention) —');
  {
    const urlGap = 'https://promoter-d.example/events/mystery';
    const gapProposal = {
      is_event: true, is_music_event: true, title: 'Mystery Basement Session',
      start_date: futureDate, // no time, no end, no venue, no price, no promoter
      city: 'Glasgow', country: 'United Kingdom',
      genres: [{ name: 'Techno', confidence: 88 }],
      field_confidence: { title: 82, date: 78, city: 80, genres: 88 },
    };
    const out = await runExtractionPipeline(urlGap, {
      fetcher: mockFetcher({ [urlGap]: { body: '<html><title>Mystery</title><body><main>Basement soon</main></body></html>' } }),
      ai: mockAI({ [urlGap]: gapProposal }),
    });
    const ev = (await q(`select * from events where id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('missing end time stays null', ev.end_at === null);
    check('missing venue stays null', ev.venue_id === null);
    check('missing price stays null', ev.price_from === null && ev.currency === null);
    check('missing ticket URL stays null (never source URL)', ev.ticket_url === null);
    check('missing promoter stays null', ev.promoter_id === null);
    const ex = (await q(`select warnings from extractions where event_id = $1`, [out.eventId]))[0] as { warnings: string[] };
    check('date-only start carries warning into moderation', ex.warnings.some((w) => /start time unknown/.test(w)));
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: unknown genre suggestion + promoter reuse —');
  {
    const urlU = 'https://promoter-a.example/events/second-night';
    const proposal = {
      is_event: true, is_music_event: true, title: 'Second Night',
      start_date: new Date(FUTURE.getTime() + 7 * 86400_000).toISOString().slice(0, 10),
      start_time: '22:00',
      venue_name: 'The Pressing Plant', city: 'London', country: 'United Kingdom',
      promoter_name: 'Fixture Promotions', promoter_website: 'https://promoter-a.example',
      genres: [{ name: 'liquid funk', confidence: 82 }, { name: 'moombahcore', confidence: 61 }],
      field_confidence: { title: 90, date: 88, venue: 85, city: 88, promoter: 85, genres: 80 },
    };
    const genresBefore = await q(`select count(*)::int as n from genres`);
    const out = await runExtractionPipeline(urlU, {
      fetcher: mockFetcher({ [urlU]: { body: '<html><title>Second Night</title><body><main>Second Night at the Pressing Plant</main></body></html>' } }),
      ai: mockAI({ [urlU]: proposal }),
    });
    check('event created despite unknown genre', out.status === 'succeeded');
    const suggestions = await q(`select suggested_name, status from genre_suggestions where event_id = $1`, [out.eventId]);
    check('UNKNOWN GENRE SUGGESTION queued for admin', suggestions.length === 1 && (suggestions[0] as { suggested_name: string }).suggested_name === 'moombahcore');
    const genreCount = await q(`select count(*)::int as n from genres`);
    check('no genre auto-created', (genreCount[0] as { n: number }).n === (genresBefore[0] as { n: number }).n);
    const ev = (await q(`select status, venue_id, promoter_id from events where id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('unknown genre → needs_review queue', ev.status === 'needs_review');
    const venues = await q(`select count(*)::int as n from venues where name = 'The Pressing Plant'`);
    check('venue reused across extractions', (venues[0] as { n: number }).n === 1);
    const promoters = await q(`select count(*)::int as n from promoters where name = 'Fixture Promotions'`);
    check('promoter reused by domain/name', (promoters[0] as { n: number }).n === 1);
  }

  // -------------------------------------------------------------------------
  console.log('\n— pipeline: failure states —');
  {
    const mkOut = (url: string, body: string | null, proposal?: unknown, raw?: string) =>
      runExtractionPipeline(url, {
        fetcher: body == null
          ? mockFetcher({})
          : mockFetcher({ [url]: { body } }),
        ai: raw != null
          ? mockAI({}, { raw: { [url]: raw } })
          : proposal !== undefined
            ? mockAI({ [url]: proposal })
            : noAI,
      });

    const badUrl = await runExtractionPipeline('http://localhost/evil', { fetcher: mockFetcher({}), ai: noAI });
    check('unsafe URL recorded as unsafe_url', badUrl.status === 'unsafe_url');
    const nf = await mkOut('https://gone.example/events/x', null);
    check('fetch miss recorded as not_found', nf.status === 'not_found');

    const noTitle = await mkOut(
      'https://promoter-e.example/events/no-title',
      '<html><body><main>something something</main></body></html>',
      { is_event: true, is_music_event: true, start_date: futureDate, field_confidence: {} }
    );
    check('missing title → insufficient_information', noTitle.status === 'insufficient_information');

    const badDate = await mkOut(
      'https://promoter-e.example/events/bad-date',
      JSONLD_PAGE({ title: 'Bad Date Night', startDate: 'sometime in summer', canonical: 'https://promoter-e.example/events/bad-date' }),
      baseProposal
    );
    check('unparseable date → invalid_date', badDate.status === 'invalid_date');

    const malformed = await mkOut(
      'https://promoter-e.example/events/malformed-ai',
      '<html><title>Night</title><body><main>a night with no structure</main></body></html>',
      undefined,
      'I refuse to produce JSON.'
    );
    check('malformed AI JSON without structured fallback → ai_extraction_failed', malformed.status === 'ai_extraction_failed');

    const malformedWithLd = await mkOut(
      'https://promoter-e.example/events/malformed-ai-ld',
      JSONLD_PAGE({ title: 'Resilient Night', canonical: 'https://promoter-e.example/events/malformed-ai-ld', ticketUrl: 'https://tickets.example/res' }),
      undefined,
      '{"broken": '
    );
    // The fixture shares venue/date/lineup with an earlier event, so the
    // draft may legitimately carry a duplicate flag — the point is that
    // structured data alone still produced a reviewable draft.
    check('malformed AI JSON with structured data → draft still created',
      ['succeeded', 'possible_duplicate'].includes(malformedWithLd.status) && malformedWithLd.eventId != null);
    const resEv = (await q(`select status from events where id = $1`, [malformedWithLd.eventId]))[0] as { status: string };
    check('degraded extraction lands in review, never live', resEv.status !== 'live');

    const notEvent = await mkOut(
      'https://promoter-e.example/shop',
      '<html><title>Merch shop</title><body><main>t-shirts and records</main></body></html>',
      { is_event: false, field_confidence: {} }
    );
    check('non-event page → not_an_event', notEvent.status === 'not_an_event');

    const irrelevant = await mkOut(
      'https://theatre.example/events/play',
      '<html><title>A Play</title><body><main>A three act play, eight pm</main></body></html>',
      {
        is_event: true, is_music_event: false, title: 'A Serious Play',
        start_date: futureDate, start_time: '19:30', city: 'London', country: 'United Kingdom',
        genres: [], field_confidence: { title: 90, date: 88, city: 85 },
      }
    );
    check('irrelevant event → not_relevant (kept out of queue)', irrelevant.status === 'not_relevant');
    const irrelevantEvents = await q(`select count(*)::int as n from events where title = 'A Serious Play'`);
    check('irrelevant event creates no event row', (irrelevantEvents[0] as { n: number }).n === 0);
    const irrelevantEx = await q(`select relevance, failure_detail from extractions where url = 'https://theatre.example/events/play'`);
    check('irrelevance reason preserved for source analysis', (irrelevantEx[0] as { relevance: string }).relevance === 'not_relevant');
  }

  // -------------------------------------------------------------------------
  console.log('\n— source scanning (HTML + seen URLs + RSS) —');
  let sourceAId: string;
  {
    // Deterministic candidate identification (pure).
    const links = identifyCandidateLinks(LISTING_PAGE, 'https://promoter-a.example/whats-on');
    check('event-like links identified', links.includes('https://promoter-a.example/events/warehouse-frequencies') && links.includes('https://promoter-a.example/events/second-night'));
    check('utm params stripped + fragments dropped + deduped', links.filter((l) => l.includes('warehouse-frequencies')).length === 1 && !links.some((l) => l.includes('utm_') || l.includes('#')));
    check('offsite /events links allowed, junk links excluded', links.includes('https://other-site.example/events/away-day') && !links.some((l) => l.includes('/privacy') || l.includes('/news/')));
    check('feed link parsing (RSS)', parseFeedLinks(RSS_FEED, 'https://promoter-b.example/feed.xml').length === 2);
    check('URL canonicalisation strips tracking', canonicaliseCandidateUrl('/e/x?utm_source=a&id=9#frag', 'https://p.example/') === 'https://p.example/e/x?id=9');

    const src = (await q(
      `insert into event_sources (source_type, name, url) values ('promoter_website', 'Promoter A', 'https://promoter-a.example/whats-on') returning id`
    ))[0] as { id: string };
    sourceAId = src.id;

    const scanFetcher = mockFetcher({
      'https://promoter-a.example/whats-on': { body: LISTING_PAGE },
      // warehouse-frequencies already exists → exact dup link; second-night already extracted above → dup too.
      'https://promoter-a.example/events/warehouse-frequencies': { body: JSONLD_PAGE({ canonical: urlA }) },
      'https://promoter-a.example/events/second-night': { body: '<html><title>Second Night</title><body><main>Second Night</main></body></html>' },
      'https://other-site.example/events/away-day': {
        body: JSONLD_PAGE({ title: 'Away Day', startDate: `${futureDate}T14:00:00+01:00`, endDate: null, venue: 'Away Field', city: 'Margate', canonical: 'https://other-site.example/events/away-day', ticketUrl: 'https://tickets.example/away' }),
      },
    });
    const scanAI = mockAI({
      default: baseProposal,
      'https://promoter-a.example/events/second-night': {
        is_event: true, is_music_event: true, title: 'Second Night',
        start_date: new Date(FUTURE.getTime() + 7 * 86400_000).toISOString().slice(0, 10), start_time: '22:00',
        venue_name: 'The Pressing Plant', city: 'London', country: 'United Kingdom',
        genres: [{ name: 'Techno', confidence: 90 }],
        field_confidence: { title: 90, date: 88, venue: 85, city: 88, genres: 88 },
      },
    });

    const scan1 = await scanSource(sourceAId, { fetcher: scanFetcher, ai: scanAI, delayMs: 1 });
    check('scan succeeds via HTML', scan1.status === 'succeeded' && scan1.method === 'html');
    check('candidates counted', scan1.candidatesFound === 3);
    check('all candidates new on first scan', scan1.newCandidates === 3);
    check('duplicates linked during scan, not recreated', scan1.duplicates === 2);
    check('new event extracted from scan', scan1.extracted === 1);
    const awayEvent = await q(`select id, source_id, status from events where title = 'Away Day'`);
    check('scanned event carries its source', awayEvent.length === 1 && (awayEvent[0] as { source_id: string }).source_id === sourceAId);
    // An advertised feed is a fallback, not an upgrade: while the listing page
    // is yielding events, adopting the site's generic feed would quietly
    // redirect every later scan away from the page that works.
    const feedSaved = (await q(`select feed_url from event_sources where id = $1`, [sourceAId]))[0] as { feed_url: string | null };
    check('advertised feed ignored while the listing page is working', feedSaved.feed_url === null);

    // Second scan: everything already seen.
    const scan2 = await scanSource(sourceAId, {
      fetcher: mockFetcher({
        'https://promoter-a.example/whats-on': { body: LISTING_PAGE },
        'https://promoter-a.example/feed.xml': { body: LISTING_PAGE }, // feed_url now set; serve HTML → falls back? it's html content
      }),
      ai: noAI, delayMs: 1,
    });
    check('already-seen URLs skipped on rescan', scan2.newCandidates === 0 && scan2.extracted === 0);
    const scanRows = await q(`select count(*)::int as n from source_scans where source_id = $1`, [sourceAId]);
    check('scan metrics recorded per scan', (scanRows[0] as { n: number }).n === 2);
  }

  // RSS-first source.
  {
    const src = (await q(
      `insert into event_sources (source_type, name, url) values ('rss_feed', 'Promoter B feed', 'https://promoter-b.example/feed.xml') returning id`
    ))[0] as { id: string };
    const feedProposal = (title: string) => ({
      is_event: true, is_music_event: true, title,
      start_date: new Date(FUTURE.getTime() + 14 * 86400_000).toISOString().slice(0, 10), start_time: '21:00',
      city: 'Bristol', country: 'United Kingdom',
      genres: [{ name: 'Breaks', confidence: 85 }],
      field_confidence: { title: 88, date: 85, city: 85, genres: 85 },
    });
    const scan = await scanSource(src.id, {
      fetcher: mockFetcher({
        'https://promoter-b.example/feed.xml': { body: RSS_FEED, contentType: 'application/rss+xml' },
        'https://promoter-b.example/events/feed-night-one': { body: '<html><title>Feed Night One</title><body><main>one</main></body></html>' },
        'https://promoter-b.example/events/feed-night-two': { body: '<html><title>Feed Night Two</title><body><main>two</main></body></html>' },
      }),
      ai: mockAI({
        'https://promoter-b.example/events/feed-night-one': feedProposal('Feed Night One'),
        'https://promoter-b.example/events/feed-night-two': feedProposal('Feed Night Two'),
      }),
      delayMs: 1,
    });
    check('RSS scan detected and used', scan.status === 'succeeded' && scan.method === 'rss');
    check('RSS entries extracted', scan.extracted === 2 && scan.candidatesFound === 2);
  }

  // Source with no event links at all.
  {
    const src = (await q(
      `insert into event_sources (source_type, name, url) values ('blog_publication', 'Quiet blog', 'https://quiet.example/') returning id`
    ))[0] as { id: string };
    const scan = await scanSource(src.id, {
      fetcher: mockFetcher({
        'https://quiet.example/': { body: '<html><body><main><a href="/about">About us</a><p>No events here.</p></main></body></html>' },
      }),
      ai: noAI, delayMs: 1,
    });
    check('source with no events → clean empty scan', scan.status === 'succeeded' && scan.candidatesFound === 0 && scan.failed === 0);
  }

  // Listing page with no event links, but a working advertised feed: this is
  // the one case where the feed IS adopted, so later scans use it.
  {
    const src = (await q(
      `insert into event_sources (source_type, name, url) values ('promoter_website', 'Feed fallback', 'https://fallback.example/whats-on') returning id`
    ))[0] as { id: string };
    await scanSource(src.id, {
      fetcher: mockFetcher({
        'https://fallback.example/whats-on': {
          body: `<!doctype html><html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>
<body><main><a href="/about">About</a></main></body></html>`,
        },
        'https://fallback.example/feed.xml': {
          body: `<?xml version="1.0"?><rss version="2.0"><channel><title>Fallback</title>
<item><title>Night</title><link>https://fallback.example/events/night</link></item></channel></rss>`,
          contentType: 'application/rss+xml',
        },
        'https://fallback.example/events/night': { body: '<html><title>Night</title><body><main>night</main></body></html>' },
      }),
      ai: noAI, delayMs: 1,
    });
    const adopted = (await q(`select feed_url from event_sources where id = $1`, [src.id]))[0] as { feed_url: string | null };
    check('advertised feed adopted when the listing page finds nothing',
      adopted.feed_url === 'https://fallback.example/feed.xml', JSON.stringify(adopted));
  }

  // -------------------------------------------------------------------------
  console.log('\n— trusted-source auto-publish rules —');
  {
    const src = (await q(
      `insert into event_sources (source_type, name, url, trust)
       values ('promoter_website', 'Trusted Promoter', 'https://trusted.example/events', 'trusted') returning id`
    ))[0] as { id: string };
    const urlT = 'https://trusted.example/events/big-room-night';
    const out = await runExtractionPipeline(urlT, {
      sourceId: src.id, scanKind: 'source_scan',
      fetcher: mockFetcher({
        [urlT]: { body: JSONLD_PAGE({ title: 'Big Room Night', venue: 'Trusted Hall', city: 'Manchester', canonical: urlT, ticketUrl: 'https://tickets.example/brn' }) },
      }),
      ai: mockAI({ default: { ...baseProposal, genres: [{ name: 'Techno', confidence: 95 }] } }),
    });
    check('trusted source + clean extraction → auto-published', out.autoPublished);
    const ev = (await q(`select status, published_at from events where id = $1`, [out.eventId]))[0] as Record<string, unknown>;
    check('auto-published event is live with timestamp', ev.status === 'live' && ev.published_at != null);

    // Same trusted source, but the event collides with an existing one.
    const urlT2 = 'https://trusted.example/events/big-room-night-again';
    const out2 = await runExtractionPipeline(urlT2, {
      sourceId: src.id, scanKind: 'source_scan',
      fetcher: mockFetcher({
        [urlT2]: { body: JSONLD_PAGE({ title: 'Big Room Night', venue: 'Trusted Hall', city: 'Manchester', canonical: urlT2, ticketUrl: null }) },
      }),
      ai: mockAI({ default: { ...baseProposal, genres: [{ name: 'Techno', confidence: 95 }] } }),
    });
    check('auto-publish blocked by duplicate warning', !out2.autoPublished);
    if (out2.eventId) {
      const ev2 = (await q(`select status from events where id = $1`, [out2.eventId]))[0] as { status: string };
      check('duplicate lands in needs_review instead', ev2.status === 'needs_review');
    } else {
      check('duplicate lands in needs_review instead', out2.status === 'duplicate_linked');
    }

    // Low-confidence extraction from the same trusted source stays in review.
    const urlT3 = 'https://trusted.example/events/vague-night';
    const out3 = await runExtractionPipeline(urlT3, {
      sourceId: src.id, scanKind: 'source_scan',
      fetcher: mockFetcher({ [urlT3]: { body: '<html><title>Vague Night</title><body><main>details tba</main></body></html>' } }),
      ai: mockAI({
        default: {
          is_event: true, is_music_event: true, title: 'Vague Night',
          start_date: futureDate, city: 'Manchester', country: 'United Kingdom',
          genres: [{ name: 'House', confidence: 55 }],
          field_confidence: { title: 60, date: 55, city: 50, genres: 55 },
        },
      }),
    });
    check('low confidence → review queue even when trusted', !out3.autoPublished && out3.eventId != null);
  }

  // -------------------------------------------------------------------------
  console.log('\n— source discovery (suggestions are never trusted) —');
  {
    const fake = (text: string): DiscoveryClient => ({
      available: true,
      async propose() { return { ok: true, text, model: 'fake' }; },
    });
    const req = { country: 'Tanzania', city: 'Dar es Salaam', genres: ['House'], limit: 5 };

    const good = await discoverSources(req, fake(JSON.stringify({
      candidates: [
        { name: 'Elements Club', url: 'https://elements.example/events', kind: 'venue_website',
          city: 'Dar es Salaam', country: 'Tanzania', genres: ['House'], note: 'Weekly house night' },
      ],
    })));
    check('discovery returns a normalised candidate',
      good.ok && good.candidates.length === 1 && good.candidates[0].url === 'https://elements.example/events');

    // Aggregators and ticketing platforms are exactly what the independent
    // event graph exists to avoid, so they never survive normalisation.
    const banned = normaliseCandidates({ candidates: [
      { name: 'RA listing', url: 'https://ra.co/clubs/123' },
      { name: 'Eventbrite', url: 'https://www.eventbrite.co.uk/d/tanzania/music' },
      { name: 'Real club', url: 'https://realclub.example/whats-on' },
    ] }, req);
    check('aggregator suggestions are dropped',
      banned.length === 1 && banned[0].url === 'https://realclub.example/whats-on');
    check('banned-host check covers subdomains', isBannedCandidateHost('www.dice.fm') && isBannedCandidateHost('m.facebook.com'));

    const junk = normaliseCandidates({ candidates: [
      { name: 'No scheme', url: 'notaurl' },
      { name: 'Local', url: 'javascript:alert(1)' },
      { name: 'Dupe', url: 'https://dupe.example/events' },
      { name: 'Dupe again', url: 'https://dupe.example/events/' },
    ] }, req);
    check('malformed and duplicate suggestions are dropped',
      junk.length === 1 && junk[0].url === 'https://dupe.example/events');

    // Any ONE of the requested genres is enough to qualify a place: a drum &
    // bass club belongs in the results of a house/techno/d&b search.
    check('the request tells the model any one genre is enough',
      buildDiscoveryUser({ ...req, genres: ['House', 'Techno'] }).includes('any one of these is enough'));
    check('the system prompt states the any-of matching rule',
      /ANY ONE of the requested genres/.test(DISCOVERY_SYSTEM_PROMPT)
      && /does not have to cover them all/i.test(DISCOVERY_SYSTEM_PROMPT));

    // What an added source gets TAGGED with comes from the candidate itself,
    // matched against our own taxonomy — never a name we do not have.
    const taxonomy = [
      { id: '11111111-1111-1111-1111-111111111111', name: 'House' },
      { id: '22222222-2222-2222-2222-222222222222', name: 'Drum & Bass' },
    ];
    check('candidate genres map onto our taxonomy',
      matchGenreIdsByName(['house', ' Drum & Bass '], taxonomy).length === 2);
    check('unknown genre names are dropped, not invented',
      matchGenreIdsByName(['Polka', 'House'], taxonomy).join() === taxonomy[0].id);

    const unavailable = await discoverSources(req, { available: false, async propose() { return { ok: false, detail: 'no key' }; } });
    check('discovery says so when no API key is configured', !unavailable.ok && unavailable.error === 'unavailable');
    const garbled = await discoverSources(req, fake('sorry, I cannot help with that'));
    check('unparseable model output is an error, not a candidate', !garbled.ok);
  }

  // -------------------------------------------------------------------------
  console.log('\n— finished events never clog the review queues —');
  {
    // A listing page full of last month's nights: read, recorded, dropped.
    const urlP = 'https://promoter-g.example/events/last-month';
    const lastMonth = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
    const pastBody = `<html><head><script type="application/ld+json">${JSON.stringify({
      '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Last Month Night',
      startDate: `${lastMonth}T21:00:00+01:00`, genre: 'House',
      location: { '@type': 'Place', name: 'Gone Hall', address: { '@type': 'PostalAddress', addressLocality: 'Leeds', addressCountry: 'United Kingdom' } },
    })}</script></head><body><main>Over</main></body></html>`;
    const venuesBefore = (await q(`select count(*)::int as n from venues where name = 'Gone Hall'`))[0].n;
    const past = await runExtractionPipeline(urlP, { fetcher: mockFetcher({ [urlP]: { body: pastBody } }), ai: noAI });
    check('a finished event is recorded as event_finished, not imported',
      past.status === 'event_finished' && past.eventId === null, past.status);
    check('no event row was made for it',
      (await q(`select count(*)::int as n from events where title = 'Last Month Night'`))[0].n === 0);
    check('no venue was created on its account',
      (await q(`select count(*)::int as n from venues where name = 'Gone Hall'`))[0].n === venuesBefore);
    check('the extraction remembers it, so a rescan does not retry it',
      (await q(`select status from extractions where id = $1`, [past.extractionId]))[0].status === 'event_finished');
    check('the scan explains it in plain words', outcomeLabel('event_finished') === 'an event that has already happened');

    // Publish all: finished unpublished events are deleted from BOTH queues,
    // duplicates wait for a person, everything else goes live.
    const admin = (await q(`select id from members where role = 'admin' limit 1`))[0].id;
    const mk = async (slug: string, status: string, startSql: string, dupOf: string | null = null) =>
      (await q(
        `insert into events (slug, title, title_normalized, start_at, timezone, status, city, country, possible_duplicate_of)
         values ($1, $1, $1, ${startSql}, 'Europe/London', $2::event_status, 'Leeds', 'United Kingdom', $3)
         returning id`, [slug, status, dupOf]))[0].id as string;
    const soon = `now() + interval '10 days'`;
    const gone = `now() - interval '10 days'`;
    const ok = await mk('purge-ok', 'new', soon);
    const target = await mk('purge-target', 'live', soon);
    const dup = await mk('purge-dup', 'new', soon, target);
    const pastNew = await mk('purge-past-new', 'new', gone);
    const pastReview = await mk('purge-past-review', 'needs_review', gone);
    const pastDup = await mk('purge-past-dup', 'needs_review', gone, target);
    const pastLive = await mk('purge-past-live', 'live', gone);
    const pastRejected = await mk('purge-past-rejected', 'rejected', gone);
    // Ended an hour ago, though it started yesterday: over is over.
    const endedToday = (await q(
      `insert into events (slug, title, title_normalized, start_at, end_at, timezone, status, city, country)
       values ('purge-ended', 'purge-ended', 'purge-ended', now() - interval '20 hours', now() - interval '1 hour',
               'Europe/London', 'needs_review', 'Leeds', 'United Kingdom') returning id`))[0].id as string;
    // Still on right now: started two hours ago, no end time.
    const onNow = await mk('purge-on-now', 'needs_review', `now() - interval '2 hours'`);

    const res = await publishQueue('new', admin);
    const left = await q(`select slug, status::text from events where slug like 'purge-%'`);
    const has = (slug: string) => left.find((r: { slug: string }) => r.slug === slug);
    check('publish all publishes everything bar duplicates',
      has('purge-ok')?.status === 'live' && has('purge-dup')?.status === 'new', JSON.stringify(res));
    check('finished events in both queues are deleted, duplicates included',
      !has('purge-past-new') && !has('purge-past-review') && !has('purge-past-dup') && !has('purge-ended'));
    check('it says how many it cleared', res.purgedPast >= 4 && res.skippedDuplicates >= 1, JSON.stringify(res));
    check('live and rejected events are never purged',
      has('purge-past-live')?.status === 'live' && has('purge-past-rejected')?.status === 'rejected');
    check('an event happening right now is kept', has('purge-on-now')?.status === 'needs_review');
    check('the purge is in the audit log',
      (await q(`select count(*)::int as n from audit_log where action = 'events_finished_purged'`))[0].n > 0);
    check('a second purge has nothing to do', (await purgeFinishedUnpublished()) === 0);
    void [ok, dup, pastNew, pastReview, pastDup, pastLive, pastRejected, endedToday, onNow];
    await q(`delete from events where slug like 'purge-%'`);
  }

  // -------------------------------------------------------------------------
  console.log('\n— monthly source suggestions (5 dnb, 5 house, 5 hip hop) —');
  {
    const taxonomy = [
      { id: 'a', name: 'Deep House' }, { id: 'b', name: 'House' }, { id: 'c', name: 'Drum & Bass' },
      { id: 'd', name: 'Jungle' }, { id: 'e', name: 'Hip Hop' }, { id: 'f', name: 'Techno' },
    ];
    check('house bucket takes every house genre we have',
      bucketGenres('house', taxonomy).map((g) => g.id).join() === 'a,b');
    check('drum & bass bucket includes jungle, not techno',
      bucketGenres('dnb', taxonomy).map((g) => g.id).join() === 'c,d');
    check('hip hop bucket matches hip hop', bucketGenres('hiphop', taxonomy).map((g) => g.id).join() === 'e');

    const probeOk = (url: string, candidates = 6): ProbeResult => ({
      target: url, method: 'html', candidates,
      bot: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      browser: { ok: true, status: 200, code: null, detail: null, ms: 10 },
    });
    check('a probe with event links passes', probePassed(probeOk('https://x.example/events')));
    check('a probe with no event links does not', !probePassed(probeOk('https://x.example/events', 0)));
    check('a client-rendered page does not',
      !probePassed({ ...probeOk('https://x.example/events', 2), clientRendered: true }));

    await q(`delete from source_suggestions`);
    await q(`delete from source_suggestion_searches`);
    await q(`insert into event_sources (source_type, name, url, country)
             values ('venue_website', 'Already Monitored', 'https://known.example/events', 'Suggestland')`);
    await q(`insert into source_suggestion_countries (country) values ('Extraland') on conflict do nothing`);
    for (const name of ['House', 'Drum & Bass', 'Hip Hop']) {
      await q(`insert into genres (name, slug) values ($1, $2) on conflict do nothing`,
        [name, name.toLowerCase().replace(/[^a-z]+/g, '-')]);
    }

    // Every call proposes: one we already monitor, one festival (not a
    // promoter or club), one that fails its test, and four good ones.
    // Stands in for a real scan: marks the source scanned, as the scanner does.
    const scannedSources: string[] = [];
    const noScan = async (sourceId: string) => {
      scannedSources.push(sourceId);
      await q(`update event_sources set last_checked_at = now() where id = $1`, [sourceId]);
    };
    let calls = 0;
    const prompts: string[] = [];
    const client: DiscoveryClient = {
      available: true,
      async propose({ user }) {
        calls++;
        prompts.push(user);
        const n = calls;
        return { ok: true, model: 'fake', text: JSON.stringify({ candidates: [
          { name: 'Known', url: 'https://www.known.example/whats-on', kind: 'venue_website' },
          { name: 'Fest', url: `https://fest${n}.example/lineup`, kind: 'festival_website' },
          { name: 'Broken', url: `https://broken${n}.example/events`, kind: 'promoter_website' },
          ...[1, 2, 3, 4].map((i) => ({
            name: `Club ${n}-${i}`, url: `https://club${n}-${i}.example/events`,
            kind: i % 2 ? 'venue_website' : 'promoter_website', city: 'Testville', genres: ['House'],
          })),
        ] }) };
      },
    };
    const probed: string[] = [];
    const probe = async (url: string) => {
      probed.push(url);
      return url.includes('broken') ? probeOk(url, 0) : probeOk(url);
    };
    let clock = 0;
    const at = new Date('2026-10-01T07:12:00Z');
    const first = await runMonthlySuggestions({ client, probe, now: () => clock, notify: false, scan: noScan }, at);
    const rows = await q(`select genre_key, host, kind, status from source_suggestions where batch_month = '2026-10'`);
    const per = (k: string) => rows.filter((r: { genre_key: string }) => r.genre_key === k).length;
    check('five suggestions per genre', per('dnb') === 5 && per('house') === 5 && per('hiphop') === 5,
      JSON.stringify(first.buckets));
    check('a site we already monitor is never suggested',
      !rows.some((r: { host: string }) => r.host === 'known.example') && !probed.some((u) => u.includes('known.example')));
    check('only promoters and clubs are suggested',
      rows.every((r: { kind: string }) => ['venue_website', 'promoter_website'].includes(r.kind)));
    check('a site that fails the scanner test is not suggested',
      !rows.some((r: { host: string }) => r.host.startsWith('broken')));
    check('a genre that runs short moves on to the next country', first.buckets.every((b) => b.countries.length === 2));
    check('the prompt names the genre bucket', prompts.some((p) => /Drum & Bass/.test(p)) && prompts.some((p) => /Hip Hop/.test(p)));
    const hipHop = first.buckets.find((b) => b.key === 'hiphop')!;
    check('hip hop searches US cities, starting with New York',
      hipHop.countries[0] === 'New York, United States'
      && hipHop.countries.every((c) => c.endsWith(', United States'))
      && prompts.some((p) => /Country: United States/.test(p) && /City: New York/.test(p)));
    check('the other genres still rotate through our own countries',
      first.buckets.filter((b) => b.key !== 'hiphop').every((b) => b.countries.every((c) => !c.includes(','))));
    const searched = await q(`select distinct country from source_suggestion_searches`);
    check('searches are logged per country for the rotation', searched.length >= 2);

    // A second run in the same month has nothing to do and asks no one.
    const before = calls;
    const again = await runMonthlySuggestions({ client, probe, now: () => clock, notify: false, scan: noScan }, at);
    check('a full month is a no-op: no AI calls, nothing added',
      calls === before && again.buckets.every((b) => b.added === 0));

    // The admins hear about it once a month, however many runs there are.
    const admins = await q(`select count(*)::int as n from members where role = 'admin'`);
    const mailed = await runMonthlySuggestions({ client, probe, now: () => clock, notify: true, scan: noScan }, at);
    const twice = await runMonthlySuggestions({ client, probe, now: () => clock, notify: true, scan: noScan }, at);
    const outbox = await q(`select count(*)::int as n from email_outbox where email_type = 'notification:source_suggestions'`);
    check('a full batch emails every admin, once',
      admins[0].n > 0 && mailed.emailed === admins[0].n && twice.emailed === 0 && outbox[0].n === admins[0].n,
      `admins=${admins[0].n} emailed=${mailed.emailed}/${twice.emailed} outbox=${outbox[0].n}`);

    // Dismissed stays dismissed — next month never brings it back.
    await q(`update source_suggestions set status = 'dismissed' where host = 'club1-1.example'`);
    const replay: DiscoveryClient = {
      available: true,
      async propose() {
        return { ok: true, model: 'fake', text: JSON.stringify({ candidates: [
          { name: 'Club 1-1', url: 'https://club1-1.example/events', kind: 'venue_website' },
        ] }) };
      },
    };
    await runMonthlySuggestions({ client: replay, probe, now: () => clock, notify: false, scan: noScan }, new Date('2026-11-01T07:12:00Z'));
    const nov = await q(`select host from source_suggestions where batch_month = '2026-11'`);
    check('a dismissed site is never suggested again', nov.length === 0);

    // Out of time: stops cleanly and leaves the rest for the next run.
    await q(`delete from source_suggestions where batch_month = '2026-12'`);
    let t = 0;
    const slow = await runMonthlySuggestions(
      { client, probe: async (u) => { t += 100_000; return probe(u); }, now: () => t, notify: false, scan: noScan },
      new Date('2026-12-01T07:12:00Z'));
    check('a run that runs out of time stops early and says so', slow.outOfTime);

    // Every genre gets a turn, even when each search is slow: one search per
    // genre per round, rather than one genre using the whole run.
    let tick = 0;
    const slowClient: DiscoveryClient = {
      available: true,
      async propose(input) { tick += 70_000; return client.propose(input); },
    };
    const fair = await runMonthlySuggestions(
      { client: slowClient, probe, now: () => tick, notify: false, scan: noScan }, new Date('2027-02-01T07:12:00Z'));
    check('a short run still searches every genre once',
      fair.outOfTime && fair.buckets.every((b) => b.countries.length === 1), JSON.stringify(fair.buckets));

    // Next month, hip hop moves on to a city it has not searched yet.
    const march = await runMonthlySuggestions({ client, probe, now: () => 0, notify: false, scan: noScan }, new Date('2027-03-01T07:12:00Z'));
    const marchCities = march.buckets.find((b) => b.key === 'hiphop')!.countries;
    check('hip hop rotates to cities it has not searched yet',
      marchCities.length > 0 && !marchCities.some((c) => hipHop.countries.includes(c)), marchCities.join(' | '));

    const noKey = await runMonthlySuggestions(
      { client: { available: false, async propose() { return { ok: false, detail: 'no key' }; } },
        probe, now: () => 0, notify: false, scan: noScan }, new Date('2027-01-01T07:12:00Z'));
    check('no API key is reported, not hidden',
      noKey.buckets.every((b) => b.added === 0 && b.errors.length === 1));

    // ---- added and scanned for you; Poll and Dismiss decide ----------------
    const octSources = await q(
      `select ss.id, ss.source_id, src.polling_enabled, src.active
         from source_suggestions ss left join event_sources src on src.id = ss.source_id
        where ss.batch_month = '2026-10' and ss.status = 'pending' order by ss.created_at`);
    check('every suggestion gets a source straight away',
      octSources.length > 0 && octSources.every((r: { source_id: string | null }) => !!r.source_id));
    check('…switched on but not polling until someone decides',
      octSources.every((r: { polling_enabled: boolean; active: boolean }) => r.active && !r.polling_enabled));
    check('the run scans the new suggestions with the time it has left',
      octSources.every((r: { source_id: string }) => scannedSources.includes(r.source_id)));

    // Events a suggestion's source found are held out of the review queue.
    const [keep, toss] = octSources as { id: string; source_id: string }[];
    const otherSrc = (await q(`select id from event_sources where url = 'https://known.example/events'`))[0].id;
    const evFor = async (slug: string, sourceIds: string[], dupOf: string | null = null) => {
      const id = (await q(
        `insert into events (slug, title, title_normalized, start_at, timezone, status, city, country, possible_duplicate_of)
         values ($1, $1, $1, now() + interval '12 days', 'Europe/London', 'new', 'Leeds', 'United Kingdom', $2)
         returning id`, [slug, dupOf]))[0].id as string;
      for (const sid of sourceIds) {
        await q(`insert into event_source_links (event_id, source_id, url, kind) values ($1, $2, $3, 'source_scan')`,
          [id, sid, `https://x.example/${slug}/${sid}`]);
      }
      return id;
    };
    const held = await evFor('sugg-held', [keep.source_id]);
    const heldDup = await evFor('sugg-held-dup', [keep.source_id], held);
    const shared = await evFor('sugg-shared', [toss.source_id, otherSrc]);
    const tossOnly = await evFor('sugg-toss-only', [toss.source_id]);
    const isHeld = async (id: string) =>
      (await q(`select ${heldForSuggestionSql('e')} as h from events e where e.id = $1`, [id]))[0].h;
    check('an event only a pending suggestion found is held out of the queue', await isHeld(held));
    check('an event another source also lists is not held', !(await isHeld(shared)));
    const admin2 = (await q(`select id from members where role = 'admin' limit 1`))[0].id;
    await publishQueue('new', admin2);
    const statusOf = async (id: string) =>
      (await q(`select status::text from events where id = $1`, [id]))[0]?.status;
    check('publish all does not publish an undecided suggestion’s events', (await statusOf(held)) === 'new');

    // Poll: on the schedule, and its events published — bar duplicates.
    const polled = await pollSuggestion(keep.id, admin2);
    const keptSrc = (await q(`select polling_enabled from event_sources where id = $1`, [keep.source_id]))[0];
    check('ticking Poll puts the source on the schedule', polled.ok && keptSrc.polling_enabled);
    check('…and publishes the events it found', (await statusOf(held)) === 'live' && polled.ok && polled.published === 1);
    check('…but a possible duplicate still waits for a person', (await statusOf(heldDup)) === 'new');
    check('…and the suggestion is marked as kept',
      (await q(`select status from source_suggestions where id = $1`, [keep.id]))[0].status === 'added');
    check('a decided suggestion cannot be polled twice', !(await pollSuggestion(keep.id, admin2)).ok);
    // Added before Poll existed, never put on the schedule: still pollable.
    const older = (octSources as { id: string; source_id: string }[])[2];
    await q(`update source_suggestions set status = 'added' where id = $1`, [older.id]);
    const late = await pollSuggestion(older.id, admin2);
    check('an added suggestion that never polled can still be ticked',
      late.ok && (await q(`select polling_enabled from event_sources where id = $1`, [older.source_id]))[0].polling_enabled);

    // Dismiss: the source goes, and the events only it brought in.
    const dismissed = await dismissSuggestion(toss.id, admin2);
    check('dismiss deletes the events only that source found',
      dismissed.ok && dismissed.deletedEvents === 1 && (await statusOf(tossOnly)) === undefined);
    check('…but keeps an event another source also lists', (await statusOf(shared)) !== undefined);
    check('…and deletes the source',
      (await q(`select count(*)::int as n from event_sources where id = $1`, [toss.source_id]))[0].n === 0);
    check('…while the suggestion stays, so the site is never suggested again',
      (await q(`select status from source_suggestions where id = $1`, [toss.id]))[0].status === 'dismissed');
    await q(`delete from events where slug like 'sugg-%'`);

    const mail = suggestionsEmail('2026-10', [
      { genre_key: 'house', name: 'Club <Five>', url: 'https://five.example/events', kind: 'venue_website',
        city: 'Testville', country: 'Suggestland', candidates: 6 },
    ], 'https://www.guestlist.net/admin/sources#suggestions');
    check('the email names the month and the club',
      /October 2026/.test(mail.subject) && mail.bodyText.includes('Club <Five>'));
    check('the email escapes names in HTML', mail.bodyHtml.includes('Club &lt;Five&gt;'));
    check('hostOf ignores www', hostOf('https://www.Club.example/x') === 'club.example');
  }

  // -------------------------------------------------------------------------
  console.log('\n— a page that builds itself in the browser —');
  {
    // The exact shape Amsterdam Dance Event's programme filter ships: an empty
    // results list, a loading placeholder, a client-side row template and the
    // module that will fetch them. Nothing in it to read.
    const adeShape = `<!doctype html><html><body>
      <header><a href="/en/program/">Program</a></header>
      <div class="ade-container" id="results" data-continue="true" data-module="filter-page/lazy-loading">
        <div class="ade-filter-page__results-container"><ul id="results__list"></ul></div>
        <div id="results-loading" class="ade-filter-page__loader">Loading...</div>
        <script id="template-list-event" type="text/template">
          <a href="!!url!!" class="item-events__link">!!title!!</a>
        </script>
      </div></body></html>`;
    check('an empty list plus a client template is not a guess',
      looksClientRendered(adeShape) === true);

    // A page that simply has its events in it is never mistaken for one.
    const served = `<!doctype html><html><body><main>
      <ul id="results__list">
        <li><a href="/events/one">One night</a></li>
        <li><a href="/events/two">Another night</a></li>
      </ul></main></body></html>`;
    check('a page that ships its listings is left alone',
      looksClientRendered(served) === false);

    // One weak signal on its own is not enough to accuse a page.
    check('a lone template tag is not enough to call it client-rendered',
      looksClientRendered('<html><body><script type="text/template">x</script></body></html>') === false);
    check('nor is an empty container on its own',
      looksClientRendered('<html><body><ul id="results"></ul></body></html>') === false);

    // And the four links such a page does give us are its own navigation.
    check('the links found on a client-rendered page are its chrome',
      identifyCandidateLinks(adeShape, 'https://ade.example/en/program/filter/')
        .every((u) => !/\/events?\//.test(u)));
  }

  // -------------------------------------------------------------------------
  console.log('\n— one city, one spelling —');
  {
    check('the name off the members page is fixed',
      canonicalCity('Dar es salaam') === 'Dar es Salaam'
      && canonicalCity('dar es salaam') === 'Dar es Salaam'
      && canonicalCity('DAR ES SALAAM') === 'Dar es Salaam');
    check('shouting and whispering both become a name',
      canonicalCity('LONDON') === 'London' && canonicalCity('london') === 'London'
      && canonicalCity('  zanzibar  ') === 'Zanzibar');
    check('small words inside a city stay small',
      canonicalCity('rio de janeiro') === 'Rio de Janeiro'
      && canonicalCity('stoke-on-trent') === 'Stoke-on-Trent'
      && canonicalCity('newcastle upon tyne') === 'Newcastle upon Tyne');
    check('but a small word first is still a capital',
      canonicalCity('den haag') === 'Den Haag' && canonicalCity('la paz') === 'La Paz');
    check('deliberate inner capitals are somebody’s home town, not a mistake',
      canonicalCity('DeSoto') === 'DeSoto' && canonicalCity("O'Fallon") === "O'Fallon");
    check('names no rule gets right are named',
      canonicalCity('sao paulo') === 'São Paulo' && canonicalCity('zurich') === 'Zürich');
    check('nothing is guessed at — a nickname stays a nickname',
      canonicalCity('LA') === 'La' && canonicalCity('NYC') === 'Nyc');
    check('blank is null, not an empty city',
      canonicalCity('  ') === null && canonicalCity(null) === null);
    check('a name already right is left exactly alone',
      ['London', 'Dar es Salaam', 'Rio de Janeiro', 'Zanzibar', 'Cape Town']
        .every((n) => canonicalCity(n) === n && isCanonicalCity(n)));
  }

  // -------------------------------------------------------------------------
  console.log('\n— finding the flyer —');
  {
    const page = (body: string, head = '') =>
      `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
    const at = 'https://club.example/event/tonight';

    check('a declared social image still wins',
      pickPageImage(page('<img src="/random.jpg" width="900" height="900">',
        '<meta property="og:image" content="/flyer.jpg">'), at)?.url
        === 'https://club.example/flyer.jpg');

    check('a page with no metadata still gives up its artwork',
      pickPageImage(page('<article><img src="/uploads/flyer-night.jpg" width="1080" height="1080" alt="Tonight"></article>'), at)?.url
        === 'https://club.example/uploads/flyer-night.jpg');

    check('the logo in the header never wins over the flyer in the article',
      pickPageImage(page(
        '<header><img src="/logo.png" width="400" height="400"></header>' +
        '<article><img src="/uploads/tonight.jpg" width="900" height="1200"></article>'
      ), at)?.url === 'https://club.example/uploads/tonight.jpg');

    check('a lazy-loaded image gives its real URL, not the placeholder',
      pickPageImage(page(
        '<article><img src="data:image/gif;base64,R0lGOD" data-src="/uploads/real-flyer.jpg" width="800" height="800"></article>'
      ), at)?.url === 'https://club.example/uploads/real-flyer.jpg');

    check('srcset picks the largest, not the first',
      largestInSrcset('/f-480.jpg 480w, /f-1200.jpg 1200w, /f-800.jpg 800w') === '/f-1200.jpg');

    check('a CSS background is artwork when there is no img at all',
      pickPageImage(page(
        '<div class="hero" style="background-image:url(\'/uploads/hero-flyer.jpg\')"></div>'
      ), at)?.url === 'https://club.example/uploads/hero-flyer.jpg');

    check('background-image is read whether or not it is quoted',
      backgroundImageUrl('background-image: url(/a.jpg)') === '/a.jpg'
      && backgroundImageUrl("background: #000 url('/b.jpg') no-repeat") === '/b.jpg');

    check('icons, avatars and social buttons are never the flyer',
      pickPageImage(page(
        '<article><img src="/icons/facebook.png" width="600" height="600">' +
        '<img src="/uploads/the-night.jpg" width="600" height="600"></article>'
      ), at)?.url === 'https://club.example/uploads/the-night.jpg');

    check('a WordPress thumbnail crop is not mistaken for the full image',
      pickPageImage(page('<article><img src="/uploads/flyer-150x150.jpg"></article>'), at) === null);

    check('a declared thumbnail is a thumbnail whatever it is called',
      pickPageImage(page('<article><img src="/uploads/art.jpg" width="80" height="80"></article>'), at) === null);

    check('relative and protocol-relative URLs are made absolute',
      pickPageImage(page('<article><img src="//cdn.example/uploads/x.jpg" width="900" height="900"></article>'), at)?.url
        === 'https://cdn.example/uploads/x.jpg');

    check('an SVG is a graphic, not a flyer',
      pickPageImage(page('<article><img src="/uploads/shape.svg" width="900" height="900"></article>'), at) === null);

    check('a page with nothing on it says nothing rather than guessing',
      pickPageImage(page('<article><p>No pictures here.</p></article>'), at) === null);

    check('the alternatives are offered in order, best first',
      findPageImages(page(
        '<article><img src="/uploads/main.jpg" width="1200" height="1200">' +
        '<img src="/uploads/second.jpg" width="400" height="400"></article>'
      ), at).map((i) => i.url).join(',')
        === 'https://club.example/uploads/main.jpg,https://club.example/uploads/second.jpg');

    // The whole point: a page that declares nothing still yields its picture
    // through the normal extractor, not only through the image helper.
    check('the extractor itself now falls back to the page',
      inspectPage(page(
        '<article><img src="/uploads/inspected.jpg" width="1000" height="1000"></article>'
      ), at).imageUrl?.value === 'https://club.example/uploads/inspected.jpg');
    check('and marks where it came from, so the desk can see it was a guess',
      inspectPage(page(
        '<article><img src="/uploads/inspected.jpg" width="1000" height="1000"></article>'
      ), at).imageUrl?.source === 'page');
  }

  // -------------------------------------------------------------------------
  console.log('\n— one country, one name —');
  {
    check('UK spellings all become United Kingdom',
      ['UK', 'u.k.', 'England', 'Scotland', 'Great Britain', 'GB', 'united kingdom']
        .every((v) => canonicalCountry(v) === 'United Kingdom'));
    check('US spellings all become United States',
      ['US', 'USA', 'u.s.a.', 'America', 'United States of America']
        .every((v) => canonicalCountry(v) === 'United States'));
    check('case alone never makes a second country',
      canonicalCountry('ITALY') === 'Italy' && canonicalCountry('italy') === 'Italy'
      && canonicalCountry('Italy') === 'Italy' && canonicalCountry('italia') === 'Italy');
    check('small words inside a name stay small',
      canonicalCountry('trinidad and tobago') === 'Trinidad and Tobago');
    check('a country we have no alias for is left as written, just tidied',
      canonicalCountry('   greece ') === 'Greece');
    // A general title-casing rule cannot get these right, so they are named.
    check('awkward casing is handled by name, not by cleverness',
      canonicalCountry("cote d'ivoire") === "Côte d'Ivoire"
      && canonicalCountry('ivory coast') === "Côte d'Ivoire"
      && canonicalCountry('UAE') === 'United Arab Emirates');
    check('blank is null, not an empty country',
      canonicalCountry('   ') === null && canonicalCountry(null) === null);
    // Two letters is never a country's real name — and /explore falls back to
    // a location's country_code, which is how a bare "IT" reached the screen.
    check('an ISO code becomes the country it stands for',
      canonicalCountry('IT') === 'Italy' && canonicalCountry('it') === 'Italy'
      && canonicalCountry('NL') === 'Netherlands' && canonicalCountry('ci') === "Côte d'Ivoire");
    check('a country page slug is typeable',
      countrySlug('United Kingdom') === 'united-kingdom'
      && countrySlug('Italy') === 'italy'
      && countrySlug("Côte d'Ivoire") === 'cote-d-ivoire');
    check('every alias and code lands on a name that slugs back to itself',
      ['UK', 'england', 'IT', 'italia', 'USA', 'nl'].every((v) => {
        const name = canonicalCountry(v)!;
        return canonicalCountry(name) === name && countrySlug(name).length > 1;
      }));
  }

  // -------------------------------------------------------------------------
  console.log('\n— event links are not only written in English —');
  {
    // Straight from a real search: an Italian club whose listing page is
    // /eventi. Every one of its links used to be discarded as navigation.
    const italian = identifyCandidateLinks(`<html><body><main>
      <a href="/eventi/notte-techno">Notte Techno</a>
      <a href="/serate/capodanno">Capodanno</a>
      <a href="/chi-siamo">Chi siamo</a>
      <a href="/contatti">Contatti</a>
    </main></body></html>`, 'https://cocorico.example/eventi');
    check('Italian event paths are found',
      italian.includes('https://cocorico.example/eventi/notte-techno')
      && italian.includes('https://cocorico.example/serate/capodanno'), JSON.stringify(italian));
    check('and Italian about/contact pages still are not',
      !italian.some((u) => /chi-siamo|contatti/.test(u)), JSON.stringify(italian));

    const others = identifyCandidateLinks(`<html><body><main>
      <a href="/eventos/fiesta-house">Fiesta</a>
      <a href="/veranstaltungen/nacht">Nacht</a>
      <a href="/evenements/soiree-techno">Soirée</a>
      <a href="/agenda/nacht-twee">Agenda</a>
      <a href="/impressum">Impressum</a>
    </main></body></html>`, 'https://euro.example/');
    check('Spanish, German, French and Dutch paths are found', others.length === 4, JSON.stringify(others));
    check('and their legal pages are not', !others.some((u) => /impressum/.test(u)));

    // The homepage listing-link finder speaks them too.
    check('a listing link in Italian is found on the homepage',
      findListingLink('<html><body><a href="/eventi">Eventi</a></body></html>',
        'https://cocorico.example/') === 'https://cocorico.example/eventi');
  }

  // -------------------------------------------------------------------------
  console.log('\n— sitemaps: the way into a site that blocks us or renders in JS —');
  {
    const SITEMAP = `<?xml version="1.0"?><urlset>
      <url><loc>https://blocked.example/</loc></url>
      <url><loc>https://blocked.example/about</loc></url>
      <url><loc>https://blocked.example/events/sitemap-night</loc></url>
      <url><loc>https://blocked.example/events/sitemap-day</loc></url>
    </urlset>`;

    check('a sitemap yields only event-shaped URLs',
      JSON.stringify(sitemapEventUrls(SITEMAP, 'https://blocked.example/sitemap.xml', 40))
      === JSON.stringify(['https://blocked.example/events/sitemap-night','https://blocked.example/events/sitemap-day']));
    check('a plain sitemap is not mistaken for an index',
      sitemapIndexUrls(SITEMAP, 'https://blocked.example/sitemap.xml', 5).length === 0);
    check('a sitemap index points at its children',
      sitemapIndexUrls(`<?xml version="1.0"?><sitemapindex>
        <sitemap><loc>https://x.example/sitemap-events.xml</loc></sitemap>
      </sitemapindex>`, 'https://x.example/sitemap.xml', 5)[0] === 'https://x.example/sitemap-events.xml');

    // The case that matters: the listing page refuses GuestlistBot, but the
    // sitemap serves it, and the scan turns that into real events.
    const src = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Blocked venue', 'https://blocked.example/whats-on', 'trusted') returning id`
    ))[0] as { id: string };
    const proposal = (title: string) => ({
      is_event: true, is_music_event: true, title,
      start_date: FUTURE.toISOString().slice(0, 10), start_time: '23:00',
      city: 'Rimini', country: 'Italy',
      genres: [{ name: 'Techno', confidence: 90 }],
      field_confidence: { title: 92, date: 90, city: 88, genres: 88 },
    });
    const scan = await scanSource(src.id, {
      fetcher: mockFetcher({
        // No entry for /whats-on: the mock fetcher reports it unreachable,
        // which is what a 403 looks like to the scanner.
        'https://blocked.example/sitemap.xml': { body: SITEMAP, contentType: 'application/xml' },
        'https://blocked.example/events/sitemap-night': { body: '<html><title>Sitemap Night</title><body><main>n</main></body></html>' },
        'https://blocked.example/events/sitemap-day': { body: '<html><title>Sitemap Day</title><body><main>d</main></body></html>' },
      }),
      ai: mockAI({
        'https://blocked.example/events/sitemap-night': proposal('Sitemap Night'),
        'https://blocked.example/events/sitemap-day': proposal('Sitemap Day'),
      }),
      delayMs: 1,
    });
    check('a blocked listing page falls back to the sitemap',
      scan.status === 'succeeded' && scan.method === 'sitemap', JSON.stringify(scan));
    check('and those sitemap URLs become events', scan.extracted === 2, JSON.stringify(scan));

    // And the other way round: an admin who already knows the sitemap sets it
    // as the source URL directly. That used to come back "0 candidate URLs via
    // HTML" — XML has no <a href> in it, so the HTML reader found nothing and
    // the scan looked like the site was empty. The scanner reads a sitemap as
    // a sitemap wherever it arrives from.
    const direct = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Sitemap as source', 'https://directmap.example/sitemap.xml', 'trusted') returning id`
    ))[0] as { id: string };
    const directScan = await scanSource(direct.id, {
      fetcher: mockFetcher({
        'https://directmap.example/sitemap.xml': {
          body: `<?xml version="1.0"?><urlset>
            <url><loc>https://directmap.example/about</loc></url>
            <url><loc>https://directmap.example/events/direct-one</loc></url>
          </urlset>`,
          contentType: 'application/xml',
        },
        'https://directmap.example/events/direct-one': { body: '<html><title>Direct One</title><body><main>d</main></body></html>' },
      }),
      ai: mockAI({ 'https://directmap.example/events/direct-one': proposal('Direct One') }),
      delayMs: 1,
    });
    check('a sitemap set as the source URL is read as a sitemap, not as HTML',
      directScan.method === 'sitemap' && directScan.extracted === 1, JSON.stringify(directScan));

    // A site whose sitemap.xml is only an index of other sitemaps. Pointing at
    // it should step through to the child rather than report nothing.
    const indexed = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Sitemap index as source', 'https://indexmap.example/sitemap.xml', 'trusted') returning id`
    ))[0] as { id: string };
    const indexedScan = await scanSource(indexed.id, {
      fetcher: mockFetcher({
        'https://indexmap.example/sitemap.xml': {
          body: `<?xml version="1.0"?><sitemapindex>
            <sitemap><loc>https://indexmap.example/sitemap-events.xml</loc></sitemap>
          </sitemapindex>`,
          contentType: 'application/xml',
        },
        'https://indexmap.example/sitemap-events.xml': {
          body: `<?xml version="1.0"?><urlset>
            <url><loc>https://indexmap.example/events/indexed-one</loc></url>
          </urlset>`,
          contentType: 'application/xml',
        },
        'https://indexmap.example/events/indexed-one': { body: '<html><title>Indexed One</title><body><main>i</main></body></html>' },
      }),
      ai: mockAI({ 'https://indexmap.example/events/indexed-one': proposal('Indexed One') }),
      delayMs: 1,
    });
    check('a sitemap INDEX set as the source URL steps through to its children',
      indexedScan.method === 'sitemap' && indexedScan.extracted === 1, JSON.stringify(indexedScan));

    // A big site splits its sitemap by section and the programme is never
    // first. Reading two children and giving up is how a site with hundreds of
    // event URLs came back empty.
    const INDEX_OF_MANY = `<?xml version="1.0"?><sitemapindex>
      <sitemap><loc>https://deep.example/sitemap-news.xml</loc></sitemap>
      <sitemap><loc>https://deep.example/sitemap-pages.xml</loc></sitemap>
      <sitemap><loc>https://deep.example/sitemap-artists.xml</loc></sitemap>
      <sitemap><loc>https://deep.example/sitemap-program.xml</loc></sitemap>
    </sitemapindex>`;
    check('the section sitemap named after events is opened first',
      sitemapIndexUrls(INDEX_OF_MANY, 'https://deep.example/sitemap.xml', 8)[0]
        === 'https://deep.example/sitemap-program.xml');

    const deep = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Deep index', 'https://deep.example/sitemap.xml', 'trusted') returning id`
    ))[0] as { id: string };
    const deepScan = await scanSource(deep.id, {
      fetcher: mockFetcher({
        'https://deep.example/sitemap.xml': { body: INDEX_OF_MANY, contentType: 'application/xml' },
        'https://deep.example/sitemap-news.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://deep.example/news/hello</loc></url></urlset>', contentType: 'application/xml' },
        'https://deep.example/sitemap-pages.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://deep.example/visit</loc></url></urlset>', contentType: 'application/xml' },
        'https://deep.example/sitemap-artists.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://deep.example/artist/x</loc></url></urlset>', contentType: 'application/xml' },
        'https://deep.example/sitemap-program.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://deep.example/program/deep-night</loc></url></urlset>', contentType: 'application/xml' },
        'https://deep.example/program/deep-night': { body: '<html><title>Deep Night</title><body><main>x</main></body></html>' },
      }),
      ai: mockAI({ 'https://deep.example/program/deep-night': proposal('Deep Night') }),
      delayMs: 1,
    });
    check('an index four sections deep still reaches the programme',
      deepScan.method === 'sitemap' && deepScan.extracted === 1, JSON.stringify(deepScan));

    // A sitemap is asked for with a budget that fits one. 2MB is generous for
    // a web page and small for a list of every URL on a large site, and a
    // programme sitemap that overran it was being dropped in silence.
    let sitemapBudget = 0;
    const budgetScan = await scanSource(deep.id, {
      fetcher: (url: string, options?: { maxBytes?: number }) => {
        if (url.endsWith('.xml')) sitemapBudget = Math.max(sitemapBudget, options?.maxBytes ?? 0);
        return mockFetcher({
          'https://deep.example/sitemap.xml': { body: INDEX_OF_MANY, contentType: 'application/xml' },
          'https://deep.example/sitemap-program.xml': { body: '<?xml version="1.0"?><urlset><url><loc>https://deep.example/program/deep-night</loc></url></urlset>', contentType: 'application/xml' },
          'https://deep.example/program/deep-night': { body: '<html><title>Deep Night</title><body><main>x</main></body></html>' },
        })(url);
      },
      ai: mockAI({ 'https://deep.example/program/deep-night': proposal('Deep Night') }),
      delayMs: 1,
    });
    check('a sitemap is fetched with a sitemap-sized budget, not a page-sized one',
      sitemapBudget > 2_000_000, `${sitemapBudget} — ${JSON.stringify(budgetScan)}`);

    // /sitemap.xml is a convention, not a rule. ADE's holds /en/about/ and
    // nothing else while its programme lives elsewhere — and robots.txt is
    // where a site DECLARES the sitemaps it actually has.
    const ROBOTS = `User-agent: *\nDisallow: /admin\n\nSitemap: https://declared.example/sitemap-program.xml\nsitemap: https://declared.example/sitemap-news.xml\nSitemap: https://someoneelse.example/sitemap.xml\n`;
    check('sitemaps declared in robots.txt are read out of it',
      JSON.stringify(sitemapsFromRobots(ROBOTS, 'https://declared.example'))
        === JSON.stringify(['https://declared.example/sitemap-program.xml','https://declared.example/sitemap-news.xml']),
      JSON.stringify(sitemapsFromRobots(ROBOTS, 'https://declared.example')));
    check('another site\u2019s sitemap is never followed from robots.txt',
      !sitemapsFromRobots(ROBOTS, 'https://declared.example').some((u) => u.includes('someoneelse')));
    check('a robots.txt with no sitemap lines yields nothing',
      sitemapsFromRobots('User-agent: *\nDisallow: /', 'https://declared.example').length === 0);

    // End to end: the guessed path is a dead end, the declared one is not.
    const declaredSrc = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Declared sitemap', 'https://declared.example/whats-on', 'trusted') returning id`
    ))[0] as { id: string };
    const declaredScan = await scanSource(declaredSrc.id, {
      fetcher: mockFetcher({
        // No /whats-on and no /sitemap.xml: exactly ADE's shape, where the
        // conventional path holds nothing that looks like an event.
        'https://declared.example/robots.txt': { body: ROBOTS, contentType: 'text/plain' },
        'https://declared.example/sitemap-program.xml': {
          body: '<?xml version="1.0"?><urlset><url><loc>https://declared.example/en/program/2026/come2gether/2669726/</loc></url></urlset>',
          contentType: 'application/xml',
        },
        'https://declared.example/en/program/2026/come2gether/2669726/': { body: '<html><title>Come2gether</title><body><main>c</main></body></html>' },
      }),
      ai: mockAI({ 'https://declared.example/en/program/2026/come2gether/2669726/': proposal('Come2gether') }),
      delayMs: 1,
    });
    check('a sitemap the site declares is found when the guessed path is not',
      declaredScan.method === 'sitemap' && declaredScan.extracted === 1, JSON.stringify(declaredScan));

    // THE HOLE THIS CLOSES: pointing the source STRAIGHT at a sitemap used to
    // skip the robots.txt lookup entirely — asking only ever happened when
    // the target was not already a sitemap. So the one case where a site's
    // other sitemaps matter most was the one case that never asked.
    const emptySrc = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Empty sitemap as source', 'https://declared.example/sitemap.xml', 'trusted') returning id`
    ))[0] as { id: string };
    const emptyScan = await scanSource(emptySrc.id, {
      fetcher: mockFetcher({
        // Exactly ADE's shape: the conventional sitemap is real, readable,
        // and holds only top-level pages.
        'https://declared.example/sitemap.xml': {
          body: '<?xml version="1.0"?><urlset><url><loc>https://declared.example/en/about/</loc></url></urlset>',
          contentType: 'application/xml',
        },
        'https://declared.example/robots.txt': { body: ROBOTS, contentType: 'text/plain' },
        'https://declared.example/sitemap-program.xml': {
          body: '<?xml version="1.0"?><urlset><url><loc>https://declared.example/en/program/2026/verknipt/2700001/</loc></url></urlset>',
          contentType: 'application/xml',
        },
        'https://declared.example/en/program/2026/verknipt/2700001/': { body: '<html><title>Verknipt</title><body><main>v</main></body></html>' },
      }),
      ai: mockAI({ 'https://declared.example/en/program/2026/verknipt/2700001/': proposal('Verknipt') }),
      delayMs: 1,
    });
    check('an empty sitemap as the source still asks the site for its others',
      emptyScan.method === 'sitemap' && emptyScan.extracted === 1, JSON.stringify(emptyScan));

    // "No event pages" out of five URLs and out of five thousand are
    // different diagnoses. Until the verdict said how much it read, both
    // came back as the same shrug.
    check('every URL in a sitemap is counted, not just the ones we sample',
      countSitemapUrls(`<?xml version="1.0"?><urlset>
        <url><loc>https://c.example/a</loc></url>
        <url><loc>https://c.example/b</loc></url>
        <url><loc>https://c.example/c</loc></url>
      </urlset>`) === 3);
    check('an empty sitemap counts as none', countSitemapUrls('<?xml version="1.0"?><urlset></urlset>') === 0);

    const emptyVerdict = testVerdict({
      target: 'https://c.example/sitemap.xml',
      bot: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      browser: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      method: 'sitemap' as const,
      candidates: 0,
      sitemapsRead: 3,
      urlsSeen: 4812,
      sampleUrls: ['https://c.example/en/about/', 'https://c.example/en/about/', 'https://c.example/en/press/'],
    });
    check('the verdict says how many sitemaps and URLs it got through',
      emptyVerdict.text.includes('3 sitemaps') && emptyVerdict.text.includes('4812 URLs'),
      emptyVerdict.text);

  }

  // -------------------------------------------------------------------------
  console.log('\n— rendering is a decision, never a default —');
  {
    // The whole safety of this feature is that nothing changes unless somebody
    // ticked a box AND a token exists. Two conditions, both required.
    check('with no token configured, nothing renders', !renderingConfigured());
    const plain = fetcherFor(false);
    const flagged = fetcherFor(true);
    check('an unflagged source uses the ordinary fetcher', plain === flagged || typeof plain === 'function');
    check('a flagged source falls back to the ordinary fetcher with no token',
      flagged === plain,
      'a flagged source must not get a renderer that cannot render');

    // A scan of a flagged source still works — it just does not render. This
    // is the case that matters: a rendering service having a bad day, or a
    // deployment with no token, must look like an ordinary scan and not like
    // a venue that stopped publishing.
    const rendered = (await q(
      `insert into event_sources (source_type, name, url, trust, render_js)
       values ('venue_website', 'Flagged for rendering', 'https://rendersite.example/whats-on', 'trusted', true) returning id`
    ))[0] as { id: string };
    const renderedScan = await scanSource(rendered.id, {
      fetcher: mockFetcher({
        'https://rendersite.example/whats-on': { body: '<html><body><a href="/events/render-night">Render Night</a></body></html>' },
        'https://rendersite.example/events/render-night': { body: '<html><title>Render Night</title><body><main>r</main></body></html>' },
      }),
      ai: mockAI({
        'https://rendersite.example/events/render-night': {
          is_event: true, is_music_event: true, title: 'Render Night',
          start_date: FUTURE.toISOString().slice(0, 10), start_time: '23:00',
          city: 'Amsterdam', country: 'Netherlands',
          genres: [{ name: 'Techno', confidence: 90 }],
          field_confidence: { title: 92, date: 90, city: 88, genres: 88 },
        },
      }),
      delayMs: 1,
    });
    check('a source flagged for rendering still scans without a renderer',
      renderedScan.status === 'succeeded' && renderedScan.extracted === 1, JSON.stringify(renderedScan));

    // And the verdict only mentions rendering when there is something to say.
    const noRenderer = testVerdict({
      target: 'https://shell.example/agenda',
      bot: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      browser: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      method: 'html' as const, candidates: 0, clientRendered: true,
    });
    check('with no renderer, the verdict advertises nothing',
      !noRenderer.text.toLowerCase().includes('turn on'), noRenderer.text);

    const wouldHelp = testVerdict({
      target: 'https://shell.example/agenda',
      bot: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      browser: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      method: 'html' as const, candidates: 0, clientRendered: true,
      renderedCandidates: 42,
    });
    check('when rendering would help, the verdict says so with the number',
      wouldHelp.text.includes('42 event links') && wouldHelp.text.includes('Render in a browser'),
      wouldHelp.text);
    const wouldNot = testVerdict({
      target: 'https://shell.example/agenda',
      bot: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      browser: { ok: true, status: 200, code: null, detail: null, ms: 10 },
      method: 'html' as const, candidates: 0, clientRendered: true,
      renderedCandidates: 0,
    });
    check('when rendering would not help, it says that rather than nothing',
      wouldNot.text.includes('will not help'), wouldNot.text);
  }

  // -------------------------------------------------------------------------
  console.log('\n— event links that are in the page but not in its markup —');
  {
    // The case that sends people to the network panel and finds nothing there:
    // the listing is built in the browser, but from data that came WITH the
    // document. There is no API call to catch, because there was no API call.
    const EMBEDDED = `<html><body>
      <ul id="event-results"></ul>
      <script id="__NEXT_DATA__" type="application/json">
      {"props":{"events":[
        {"id":1,"url":"\\u002Fen\\u002Fprogram\\u002Fevent\\u002F123\\u002Foliver-heldens\\u002F"},
        {"id":2,"url":"/en/program/event/456/dirty-workz/"}
      ],"endpoint":"/api/events/list","logo":"/assets/img/logo.png",
       "partner":"https://cdn.elsewhere.example/program/event/9/x/"}}
      </script>
    </body></html>`;
    const PAGE_URL = 'https://payload.example/en/program/filter/?page=1';
    const proposal = (title: string) => ({
      is_event: true, is_music_event: true, title,
      start_date: FUTURE.toISOString().slice(0, 10), start_time: '23:00',
      city: 'Amsterdam', country: 'Netherlands',
      genres: [{ name: 'Techno', confidence: 90 }],
      field_confidence: { title: 92, date: 90, city: 88, genres: 88 },
    });

    const links = identifyEmbeddedLinks(EMBEDDED, PAGE_URL);
    check('event links are read out of the data the page ships with',
      links.length === 2
      && links[0] === 'https://payload.example/en/program/event/123/oliver-heldens/',
      JSON.stringify(links));
    check('escaped slashes in a JSON payload are still a path',
      links.includes('https://payload.example/en/program/event/123/oliver-heldens/'));
    check('an API path in the payload is not offered as an event',
      !links.some((u) => u.includes('/api/')));
    check('an asset in the payload is not offered as an event',
      !links.some((u) => u.includes('/assets/')));
    check('another site\u2019s URL in the payload is ignored',
      !links.some((u) => u.includes('elsewhere.example')));
    check('the same links arrive through the ordinary reader',
      identifyCandidateLinks(EMBEDDED, PAGE_URL).length === 2);

    // A page that already lists its events properly is left alone.
    const PLAIN = `<html><body>
      <a href="/events/one">One</a><a href="/events/two">Two</a>
      <a href="/events/three">Three</a><a href="/events/four">Four</a>
      <a href="/events/five">Five</a>
      <script>var config = {"tracker":"/events/pixel-hit"};</script>
    </body></html>`;
    check('a page that already lists its events is not rummaged through',
      identifyCandidateLinks(PLAIN, 'https://plain.example/whats-on').length === 5);


    // And end to end: the shell scans, and its embedded events become events.
    const shell = (await q(
      `insert into event_sources (source_type, name, url, trust) values ('venue_website', 'Payload site', 'https://payload.example/en/program/filter/', 'trusted') returning id`
    ))[0] as { id: string };
    const shellScan = await scanSource(shell.id, {
      fetcher: mockFetcher({
        'https://payload.example/en/program/filter/': { body: EMBEDDED },
        'https://payload.example/en/program/event/123/oliver-heldens/': { body: '<html><title>Oliver Heldens</title><body><main>h</main></body></html>' },
        'https://payload.example/en/program/event/456/dirty-workz/': { body: '<html><title>Dirty Workz</title><body><main>d</main></body></html>' },
      }),
      ai: mockAI({
        'https://payload.example/en/program/event/123/oliver-heldens/': proposal('Oliver Heldens'),
        'https://payload.example/en/program/event/456/dirty-workz/': proposal('Dirty Workz'),
      }),
      delayMs: 1,
    });
    check('a client-rendered shell still yields its events',
      shellScan.method === 'html' && shellScan.extracted === 2, JSON.stringify(shellScan));

  }

  // -------------------------------------------------------------------------
  console.log('\n— a listing that arrives a page at a time —');
  {
    const ADE_API = 'https://www.amsterdam-dance-event.nl/api/program/filter/?section=events&type=8262,8263&page=0';
    check('a page parameter is followed to the next page',
      nextPageUrl(ADE_API)?.endsWith('page=1') === true, String(nextPageUrl(ADE_API)));
    check('a URL with no page parameter is not paged',
      !isPaged('https://plain.example/whats-on'));
    check('a non-numeric page value is left alone',
      !isPaged('https://plain.example/list?page=next'));
    check('offset and start are never guessed at',
      !isPaged('https://plain.example/list?offset=20') && !isPaged('https://plain.example/list?start=40'));

    // End to end, in ADE's exact shape: an HTML fragment per page, from an
    // /api/ path, with the events on it.
    const paged = (await q(
      `insert into event_sources (source_type, name, url, trust)
       values ('venue_website', 'Paged API listing', '${ADE_API}', 'trusted') returning id`
    ))[0] as { id: string };
    const fragment = (n: number) =>
      `<div><a href="/en/program/2026/act-${n}/${900000 + n}/">Act ${n}</a></div>`;
    const pageBodies: Record<string, { body: string }> = {};
    const aiPages: Record<string, unknown> = {};
    for (let n = 0; n < 3; n++) {
      pageBodies[`https://www.amsterdam-dance-event.nl/api/program/filter/?section=events&type=8262%2C8263&page=${n}`] = { body: fragment(n) };
      pageBodies[`https://www.amsterdam-dance-event.nl/en/program/2026/act-${n}/${900000 + n}/`] =
        { body: `<html><title>Act ${n}</title><body><main>a</main></body></html>` };
      aiPages[`https://www.amsterdam-dance-event.nl/en/program/2026/act-${n}/${900000 + n}/`] = {
        is_event: true, is_music_event: true, title: `Act ${n}`,
        start_date: FUTURE.toISOString().slice(0, 10), start_time: '23:00',
        city: 'Amsterdam', country: 'Netherlands',
        genres: [{ name: 'Techno', confidence: 90 }],
        field_confidence: { title: 92, date: 90, city: 88, genres: 88 },
      };
    }
    // The stored URL keeps the comma the admin typed; every URL we build from
    // it comes back percent-encoded. Both are the same page to the site.
    pageBodies['https://www.amsterdam-dance-event.nl/api/program/filter/?section=events&type=8262,8263&page=0'] = { body: fragment(0) };
    // Page 3 onwards repeats page 2's content, which is what a site does when
    // it runs out: the scan must stop there rather than loop to the cap.
    pageBodies['https://www.amsterdam-dance-event.nl/api/program/filter/?section=events&type=8262%2C8263&page=3'] = { body: fragment(2) };
    const pagedScan = await scanSource(paged.id, {
      fetcher: mockFetcher(pageBodies),
      ai: mockAI(aiPages as Parameters<typeof mockAI>[0]),
      delayMs: 1,
    });
    check('every page of a paged listing becomes events',
      pagedScan.extracted === 3, JSON.stringify(pagedScan));
    check('and a page that repeats the last one ends the walk',
      pagedScan.candidatesFound === 3, JSON.stringify(pagedScan));

  }

  // -------------------------------------------------------------------------
  console.log('\n— a listing that is not a page at all —');
  {
    // Verbatim from ADE, escaped slashes and a lying content-type included.
    const ADE_JSON = String.raw`{"data":[{"id":2812228,"handle":"events","title":"Big Bells x Audiosolo ADE 2026","start_date_time":{"date":"2026-10-21 12:00:00.000000","timezone":"Europe\/Amsterdam"},"url":"https:\/\/json.example\/en\/program\/2026\/big-bells\/2812228\/","venue":{"title":"Club Baggerbeest"},"soldOut":false},{"id":2829793,"title":"VOLT & Friends BOAT PARTY","url":"https:\/\/json.example\/en\/program\/2026\/volt-friends\/2829793\/","venue":{"title":"Somewhere"}}],"meta":{"next":"\/api\/program\/filter\/?page=1","logo":"\/assets\/logo.png","partner":"https:\/\/elsewhere.example\/program\/2026\/x\/1\/"}}`;
    const JSON_API = 'https://json.example/api/program/filter/?section=events&page=0';

    check('a body that opens with a brace is read as JSON', looksLikeJson(ADE_JSON));
    check('a body that opens with a tag is not', !looksLikeJson('<html><body>x</body></html>'));

    const links = identifyJsonLinks(ADE_JSON, JSON_API, JSON_API);
    check('event URLs are read straight out of the JSON',
      links.length === 2 && links[0] === 'https://json.example/en/program/2026/big-bells/2812228/',
      JSON.stringify(links));
    check('the API\u2019s own next-page link is not an event',
      !links.some((u) => u.includes('/api/')));
    check('an asset in the payload is not an event',
      !links.some((u) => u.includes('/assets/')));
    check('another site\u2019s URL in the payload is ignored',
      !links.some((u) => u.includes('elsewhere.example')));
    check('a body that is not JSON at all yields nothing',
      identifyJsonLinks('<html><a href="/events/x">x</a></html>', JSON_API).length === 0);

    // End to end, including pagination: a JSON listing is still a listing.
    const src = (await q(
      `insert into event_sources (source_type, name, url, trust)
       values ('venue_website', 'JSON listing', '${JSON_API}', 'trusted') returning id`
    ))[0] as { id: string };
    const jsonPage = (n: number) =>
      `{"data":[{"id":${n},"url":"https://json.example/en/program/2026/act-${n}/${n}/"}]}`;
    const bodies: Record<string, { body: string; contentType?: string }> = {
      // The lying header is the point: text/html, JSON body.
      'https://json.example/api/program/filter/?section=events&page=0': { body: jsonPage(0), contentType: 'text/html' },
      'https://json.example/api/program/filter/?section=events&page=1': { body: jsonPage(1), contentType: 'text/html' },
      'https://json.example/api/program/filter/?section=events&page=2': { body: jsonPage(1), contentType: 'text/html' },
    };
    const ai: Record<string, unknown> = {};
    for (let n = 0; n < 2; n++) {
      bodies[`https://json.example/en/program/2026/act-${n}/${n}/`] =
        { body: `<html><title>Act ${n}</title><body><main>a</main></body></html>` };
      ai[`https://json.example/en/program/2026/act-${n}/${n}/`] = {
        is_event: true, is_music_event: true, title: `Act ${n}`,
        start_date: FUTURE.toISOString().slice(0, 10), start_time: '23:00',
        city: 'Amsterdam', country: 'Netherlands',
        genres: [{ name: 'Techno', confidence: 90 }],
        field_confidence: { title: 92, date: 90, city: 88, genres: 88 },
      };
    }
    const jsonScan = await scanSource(src.id, {
      fetcher: mockFetcher(bodies),
      ai: mockAI(ai as Parameters<typeof mockAI>[0]),
      delayMs: 1,
    });
    check('a JSON listing scans, whatever its content-type claims',
      jsonScan.method === 'json' && jsonScan.extracted === 2, JSON.stringify(jsonScan));

    // Forty suits a venue and truncates a festival programme. A source that
    // needs a different ceiling carries its own; everything else keeps the
    // default without having to know the setting exists.
    check('a source with no ceiling of its own uses the default', candidateCap(null) === 40);
    check('and one that carries a ceiling uses it', candidateCap({ max_candidates: 300 }) === 300);
    check('a nonsense ceiling falls back rather than taking nothing',
      candidateCap({ max_candidates: 0 }) === 40);

    const wide = (await q(
      `insert into event_sources (source_type, name, url, trust, max_candidates)
       values ('venue_website', 'Wide festival', 'https://wide.example/api/list/?page=0', 'trusted', 60)
       returning id`
    ))[0] as { id: string };
    // Fifty events across two pages: over the default of forty, under this
    // source's sixty. Truncation at forty would be silent, so the count is
    // the assertion.
    const many = (from: number, to: number) =>
      `{"data":[${Array.from({ length: to - from }, (_, i) =>
        `{"url":"https://wide.example/events/act-${from + i}/"}`).join(',')}]}`;
    const wideBodies: Record<string, { body: string }> = {
      'https://wide.example/api/list/?page=0': { body: many(0, 25) },
      'https://wide.example/api/list/?page=1': { body: many(25, 50) },
      'https://wide.example/api/list/?page=2': { body: many(25, 50) },
    };
    const wideScan = await scanSource(wide.id, {
      fetcher: mockFetcher(wideBodies),
      ai: mockAI({}),
      delayMs: 1,
    });
    check('a source with a wider ceiling takes more than the default forty',
      wideScan.candidatesFound === 50, JSON.stringify(wideScan));

  }

  // -------------------------------------------------------------------------
  console.log('\n— a listing page\u2019s own filters are not events —');
  {
    // Verbatim from ADE: the four "candidate event links" on its programme
    // page were that same page again, with ?section=persons, ?section=venues
    // and a different type. They passed because the PATH says programme — and
    // it is the path we were standing on.
    const ADE = 'https://www.amsterdam-dance-event.nl/en/program/filter/?section=events&type=8262,8263&from=2026-10-21&to=2026-10-25&category=1485951';
    const TABS = `<html><body>
      <ul id="event-results"></ul>
      <a href="/en/program/filter/?section=events&type=8264&from=2026-10-21&to=2026-10-25">Other</a>
      <a href="/en/program/filter/?section=persons&type=8262%2C8263&from=2026-10-21&to=2026-10-25">Persons</a>
      <a href="/en/program/filter/?section=venues&type=8262%2C8263&from=2026-10-21&to=2026-10-25">Venues</a>
    </body></html>`;
    check('a listing page\u2019s own filter tabs are not candidate events',
      identifyCandidateLinks(TABS, ADE).length === 0,
      JSON.stringify(identifyCandidateLinks(TABS, ADE)));
    check('and they are counted so zero has a reason',
      pageFilterLinks(TABS, ADE) === 3, String(pageFilterLinks(TABS, ADE)));

    // The exception that keeps older sites working: a query key the page does
    // not have is identity, not a facet.
    const listing = new URL('https://old.example/events/?view=list');
    check('a link introducing a new query key is identity, not a filter',
      !isFacetOfPage(new URL('https://old.example/events/?id=1234'), listing));
    check('a narrower value of a key the page already has is a filter',
      isFacetOfPage(new URL('https://old.example/events/?view=grid'), listing));
    check('a different path is never a filter of this one',
      !isFacetOfPage(new URL('https://old.example/events/friday-night'), listing));
    check('a trailing slash does not make a page a different page',
      isFacetOfPage(new URL('https://old.example/events?view=grid'), listing));
    check('an event addressed by query string still survives',
      identifyCandidateLinks(
        '<html><body><a href="/events/detail?id=1234">Friday</a></body></html>',
        'https://old.example/events/detail?view=list'
      ).length === 1);

    // A redirect that drops the query must not promote the tabs to events:
    // we asked for ?section=events&category=…, we landed on the bare path,
    // and the tabs would otherwise look like links introducing new keys.
    check('a redirect that drops the query does not turn tabs into events',
      identifyCandidateLinks(TABS, 'https://www.amsterdam-dance-event.nl/en/program/filter/', ADE).length === 0,
      JSON.stringify(identifyCandidateLinks(TABS, 'https://www.amsterdam-dance-event.nl/en/program/filter/', ADE)));
    check('and they are still counted as the page\u2019s own filters',
      pageFilterLinks(TABS, 'https://www.amsterdam-dance-event.nl/en/program/filter/', ADE) === 3);
    check('a real event link survives a redirect that drops the query',
      identifyCandidateLinks(
        '<html><body><a href="/en/program/2026/oliver-heldens/998/">Oliver Heldens</a></body></html>',
        'https://www.amsterdam-dance-event.nl/en/program/filter/', ADE
      ).length === 1);
  }

  // -------------------------------------------------------------------------
  console.log('\n— a scan says WHY it found nothing —');
  {
    check('an outcome tally explains itself',
      explainScan({ not_an_event: 5 }, 0)?.includes('None of those links were event pages') === true);
    check('a homepage is named as the likely cause',
      explainScan({ not_an_event: 5 }, 0)?.includes('homepage') === true);
    check('a missing AI reader is spelled out',
      outcomeLabel('ai_extraction_failed').includes('ANTHROPIC_API_KEY'));
    check('a successful scan needs no excuse', explainScan({ succeeded: 3 }, 3) === null);
    check('undated event pages are named as such',
      explainScan({ insufficient_information: 2 }, 0)?.includes('no usable date') === true);
  }

  // -------------------------------------------------------------------------
  console.log('\n— schema expectations snapshot —');
  {
    // The admin audit reads a generated snapshot, because the .sql files are
    // not in the serverless bundle. This is what stops it going stale: add a
    // migration without running `npm run schema:snapshot` and this fails.
    const { readExpectations, renderSnapshot } = await import('./schema-snapshot.mjs');
    const fresh = renderSnapshot(readExpectations());
    const committed = readFileSync(path.join(root, 'lib', 'schemaExpectations.ts'), 'utf8');
    check('lib/schemaExpectations.ts matches the migrations on disk', fresh === committed,
      'run: npm run schema:snapshot');

    const { EXPECTED_TABLES, EXPECTED_COLUMNS } = await import('@/lib/schemaExpectations');
    check('the snapshot covers the tables the homepage needs',
      EXPECTED_TABLES.includes('homepage_feed_suppressions')
      && EXPECTED_TABLES.includes('events') && EXPECTED_TABLES.includes('articles'));
    check('the snapshot covers columns added by later migrations',
      EXPECTED_COLUMNS.includes('events.listing_status')
      && EXPECTED_COLUMNS.includes('members.slug'));
    // member_connections.tier was added in 006 and dropped again in 008.
    // Expecting a column the schema deliberately no longer has would make
    // the audit cry wolf, and an audit nobody believes is worse than none.
    check('a column added and later dropped is not expected',
      !EXPECTED_COLUMNS.includes('member_connections.tier'));
  }

  // -------------------------------------------------------------------------
  console.log('\n— polling is a person\u2019s decision —');
  {
    const mk = async (name: string, url: string) => (await q(
      `insert into event_sources (source_type, name, url, trust) values ('promoter_website', $1, $2, 'trusted') returning id`,
      [name, url]
    ))[0] as { id: string };
    const polling = async (id: string) => ((await q(`select polling_enabled from event_sources where id = $1`, [id]))[0] as { polling_enabled: boolean }).polling_enabled;

    const listing = (host: string) => `<html><body><main>
      <a href="${host}/events/earned-night">Earned Night — ${futureDate}</a></main></body></html>`;
    const eventProposal = {
      is_event: true, is_music_event: true, title: 'Earned Night',
      start_date: FUTURE.toISOString().slice(0, 10), start_time: '22:00',
      city: 'Leeds', country: 'United Kingdom',
      genres: [{ name: 'Techno', confidence: 88 }],
      field_confidence: { title: 90, date: 88, city: 85, genres: 85 },
    };

    // A scan that finds nothing leaves the source off the schedule.
    const quiet = await mk('Quiet source', 'https://quiet-earner.example/whats-on');
    const quietScan = await scanSource(quiet.id, {
      fetcher: mockFetcher({ 'https://quiet-earner.example/whats-on': { body: '<html><body><main><a href="/about">About</a></main></body></html>' } }),
      ai: noAI, delayMs: 1,
    });
    check('a scan that finds nothing has nothing to offer',
      quietScan.couldPoll === false && (await polling(quiet.id)) === false);

    // A scan that brings back an event does.
    const good = await mk('Earning source', 'https://earner.example/whats-on');
    const goodScan = await scanSource(good.id, {
      fetcher: mockFetcher({
        'https://earner.example/whats-on': { body: listing('https://earner.example') },
        'https://earner.example/events/earned-night': { body: '<html><title>Earned Night</title><body><main>x</main></body></html>' },
      }),
      ai: mockAI({ 'https://earner.example/events/earned-night': eventProposal }),
      delayMs: 1,
    });
    // A productive scan OFFERS the schedule. It does not take it: whether a
    // source polls is a person's decision, and the admin who pressed "test"
    // did not ask for it to be added to the rota.
    check('a productive scan offers polling but never switches it on',
      goodScan.extracted === 1 && goodScan.couldPoll === true
      && (await polling(good.id)) === false);

    // And once it IS polling, there is nothing left to offer.
    await q(`update event_sources set polling_enabled = true where id = $1`, [good.id]);
    const rescan = await scanSource(good.id, {
      fetcher: mockFetcher({
        'https://earner.example/whats-on': { body: listing('https://earner.example') },
      }),
      ai: noAI, delayMs: 1,
    });
    check('a source already on the schedule is left exactly as it is',
      rescan.couldPoll === false && (await polling(good.id)) === true);

    // An admin who switches polling off stays switched off, however many
    // events a later scan brings back.
    await q(`update event_sources set polling_enabled = false where id = $1`, [good.id]);
    const afterOff = await scanSource(good.id, {
      fetcher: mockFetcher({
        'https://earner.example/whats-on': { body: listing('https://earner.example') },
        'https://earner.example/events/earned-night': { body: '<html><title>Earned Night 2</title><body><main>x</main></body></html>' },
      }),
      ai: mockAI({ 'https://earner.example/events/earned-night': { ...eventProposal, title: 'Earned Night 2' } }),
      delayMs: 1,
    });
    check('turning polling off stays off, whatever a later scan finds',
      (await polling(good.id)) === false);
  }

  // -------------------------------------------------------------------------
  console.log('\n— finding the real listing page when a suggested path misses —');
  {
    const home = `<html><body>
      <nav><a href="/about">About us</a><a href="/en/agenda">Agenda</a><a href="/contact">Contact</a></nav>
      <a href="https://tickets.example/buy">Tickets</a>
    </body></html>`;
    check('a listing link is found on the homepage',
      findListingLink(home, 'https://club.example/') === 'https://club.example/en/agenda');
    check('offsite links are never offered as the listing page',
      findListingLink('<html><body><a href="https://other.example/agenda">Agenda</a></body></html>',
        'https://club.example/') === null);
    check('a homepage with nothing listing-shaped yields nothing',
      findListingLink('<html><body><a href="/about">About</a><a href="/jobs">Jobs</a></body></html>',
        'https://club.example/') === null);
    // Link text alone is enough — plenty of sites use /p/1234 for the agenda.
    check('link text counts when the path says nothing',
      findListingLink('<html><body><a href="/p/1234">What\u2019s on</a></body></html>',
        'https://club.example/') === 'https://club.example/p/1234');
    check('a short matching path beats a deep one',
      findListingLink(`<html><body><a href="/news/2019/agenda-archive">Agenda archive</a>
        <a href="/agenda">Agenda</a></body></html>`, 'https://club.example/')
        === 'https://club.example/agenda');
  }

  // -------------------------------------------------------------------------
  console.log('\n— workbench vs live split —');
  {
    const base = { active: true, polling_enabled: true, failure_count: 0, events_found: 4, linked_events: 2 };
    check('polling + producing = live', isLiveSource(base));
    check('paused source stays on the bench', !isLiveSource({ ...base, active: false }));
    check('not polling stays on the bench', !isLiveSource({ ...base, polling_enabled: false }));
    check('failing source stays on the bench', !isLiveSource({ ...base, failure_count: 3 }));
    check('polling but finding nothing stays on the bench',
      !isLiveSource({ ...base, events_found: 0, linked_events: 0 }));

    const probe = (ok: boolean, candidates: number | null) => ({
      target: 'https://x.example/events',
      bot: { ok, status: ok ? 200 : null, code: ok ? null : 'dns', detail: null, ms: 10 },
      browser: { ok: false, status: null, code: 'dns', detail: null, ms: 10 },
      method: ok ? ('html' as const) : null,
      candidates,
    });
    check('a candidate with event links reads as OK', !testVerdict(probe(true, 3)).bad);
    check('a reachable page with no event links reads as a problem', testVerdict(probe(true, 0)).bad);
    check('an unreachable candidate reads as a problem', testVerdict(probe(false, null)).bad);

    // Every "reachable but nothing found" in this file's history was settled
    // by LOOKING at the response. These are the three things that produce an
    // identical HTTP 200 and need telling apart at a glance.
    check('a preview collapses whitespace so a fragment is readable',
      previewBody('<div>\n\n   <a href="/x">One</a>\n</div>') === '<div> <a href="/x">One</a> </div>');
    check('a long body is cut rather than dumped',
      previewBody('x'.repeat(5000)).length <= 701);
    check('a compressed body is called that, not printed as mojibake',
      previewBody('\u0001\u0002\u0003\u0004\u0005\u0006\u0007\u0010' .repeat(20)).includes('probably compressed'));
    check('an empty results list previews as itself',
      previewBody('<div class="results"></div>') === '<div class="results"></div>');

    // A sitemap that reads fine but has nothing event-shaped in it must not be
    // told it "renders its listings with JavaScript". XML does not render.
    const emptySitemap = { ...probe(true, 0), method: 'sitemap' as const };
    check('an empty sitemap is not blamed on JavaScript',
      testVerdict(emptySitemap).bad
      && testVerdict(emptySitemap).text.includes('sitemap')
      && !testVerdict(emptySitemap).text.includes('JavaScript'),
      testVerdict(emptySitemap).text);
    check('a sitemap full of event pages reads as OK',
      !testVerdict({ ...probe(true, 40), method: 'sitemap' as const }).bad);

    // ADE's endpoint answers [null] — six bytes — when a parameter it needs
    // is missing. Telling an admin that "the page may render its listings
    // with JavaScript" sends them after a problem that is not there.
    const emptyJson = { ...probe(true, 0), method: 'json' as const, bodyBytes: 6 };
    check('an empty JSON answer is not blamed on JavaScript',
      !testVerdict(emptyJson).text.includes('JavaScript')
      && !testVerdict(emptyJson).text.includes('raw HTML'),
      testVerdict(emptyJson).text);
    check('and it points at the parameter rather than the site',
      testVerdict(emptyJson).text.includes('missing a parameter')
      && testVerdict(emptyJson).text.includes('6 bytes'),
      testVerdict(emptyJson).text);

    // A count that IS the ceiling is a truncation, and it must not read as a
    // total — that is the whole reason the ceiling is per source.
    const atCap = { ...probe(true, 40), method: 'json' as const, cappedAt: 40 };
    check('a count that is exactly the ceiling says so',
      testVerdict(atCap).text.includes('ceiling') && testVerdict(atCap).text.includes('max'),
      testVerdict(atCap).text);
    check('a count under the ceiling does not',
      !testVerdict({ ...probe(true, 12), method: 'json' as const }).text.includes('ceiling'));
    check('a paged URL says the scan will read further',
      testVerdict({ ...probe(true, 12), method: 'json' as const, paged: true }).text.includes('follows the pages'));
    check('an unpaged one does not',
      !testVerdict({ ...probe(true, 12), method: 'json' as const }).text.includes('follows the pages'));

    // The wall a status-code comparison walks straight past: same HTTP 200
    // both times, but the browser was handed the listings and we were not.
    const twoFaced = { ...probe(true, 4), browserCandidates: 38, servesBrowsersMore: true };
    check('a site that serves browsers a different page is named as that',
      testVerdict(twoFaced).bad
      && testVerdict(twoFaced).text.includes('different page')
      && testVerdict(twoFaced).text.includes('38'),
      testVerdict(twoFaced).text);
    check('and it is not blamed on JavaScript',
      !testVerdict({ ...twoFaced, clientRendered: true }).text.includes('builds its listings'));
    check('a browser seeing a couple more links is not called a different page',
      !testVerdict({ ...probe(true, 4), browserCandidates: 6 }).text.includes('different page'));
  }

  // -------------------------------------------------------------------------
  // THE CODE THE DOOR SCANS.
  //
  // This is written out by hand rather than pulled in as a package, so it has
  // to be proved rather than trusted. Every one of the eight mask patterns is
  // compared against a reference implementation, module for module — with the
  // mask pinned on both sides, so a difference can only ever mean an encoding
  // bug and never a difference of taste in which mask looks best.
  console.log('\n— the QR code on a door pass —');
  {
    const QR = (await import('qrcode')).default;
    const { encodeQr, byteCapacity, MAX_VERSION } = await import('@/lib/qr');
    const { qrPng, greyscalePng } = await import('@/lib/png');
    const { inflateSync } = await import('node:zlib');

    const samples = [
      'https://www.guestlist.net/d/abc',
      'https://www.guestlist.net/d/9f3c1a2b4d5e6f70.1a2b3c4d5e6f7081',
      'HELLO WORLD',
      'a',
      'x'.repeat(byteCapacity(MAX_VERSION)),
      'Ünïcodé — ✓ £ 東京',
    ];

    let mismatches = 0;
    let compared = 0;
    for (const text of samples) {
      for (let mask = 0; mask < 8; mask++) {
        // Byte mode on both sides: the reference will otherwise pack uppercase
        // text more tightly using alphanumeric mode, which is a different
        // (also correct) encoding of the same string.
        const ref = QR.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], { errorCorrectionLevel: 'M', maskPattern: mask as 0|1|2|3|4|5|6|7 });
        const mine = encodeQr(text, mask);
        const n = ref.modules.size;
        if (n !== mine.size) { mismatches++; continue; }
        for (let r = 0; r < n; r++) {
          for (let c = 0; c < n; c++) {
            compared++;
            if (!!ref.modules.get(r, c) !== mine.get(r, c)) mismatches++;
          }
        }
      }
    }
    check('every mask matches a reference implementation, module for module',
      mismatches === 0 && compared > 50_000, `${mismatches} of ${compared}`);

    // And left to choose for itself, it lands where the reference lands.
    let freeChoiceDiff = 0;
    for (const text of samples) {
      const ref = QR.create([{ data: new TextEncoder().encode(text), mode: 'byte' }], { errorCorrectionLevel: 'M' });
      const mine = encodeQr(text);
      for (let r = 0; r < ref.modules.size; r++) {
        for (let c = 0; c < ref.modules.size; c++) {
          if (!!ref.modules.get(r, c) !== mine.get(r, c)) freeChoiceDiff++;
        }
      }
    }
    check('and it picks the same mask when left to itself', freeChoiceDiff === 0, String(freeChoiceDiff));

    check('the smallest version that fits is the one used', encodeQr('a').size === 21);
    check('a longer string grows the code', encodeQr('x'.repeat(200)).size > encodeQr('a').size);
    check('and there is a limit rather than a silent truncation',
      (() => { try { encodeQr('x'.repeat(byteCapacity(MAX_VERSION) + 1)); return false; } catch { return true; } })());

    // The PNG has to be a real PNG: an email client will not forgive a
    // hand-rolled file that is nearly right.
    const matrix = encodeQr('https://www.guestlist.net/d/abcdef');
    const png = qrPng(matrix, 6, 4);
    check('the PNG carries the PNG signature',
      png.subarray(0, 8).toString('hex') === '89504e470d0a1a0a');
    const chunks: Record<string, Buffer> = {};
    for (let off = 8; off < png.length;) {
      const len = png.readUInt32BE(off);
      chunks[png.subarray(off + 4, off + 8).toString('ascii')] = png.subarray(off + 8, off + 8 + len);
      off += 12 + len;
    }
    check('with a header, an image and an end', !!chunks.IHDR && !!chunks.IDAT && 'IEND' in chunks);
    const width = chunks.IHDR.readUInt32BE(0), height = chunks.IHDR.readUInt32BE(4);
    check('square, and the size the matrix asked for',
      width === height && width === (matrix.size + 8) * 6, `${width}x${height}`);
    const raw = inflateSync(chunks.IDAT);
    check('the pixels decompress to the right number of scanlines', raw.length === height * (width + 1));
    let wrongPixels = 0;
    for (let r = 0; r < matrix.size; r++) {
      for (let c = 0; c < matrix.size; c++) {
        const y = (r + 4) * 6 + 2, x = (c + 4) * 6 + 2;
        if ((raw[y * (width + 1) + 1 + x] === 0) !== matrix.get(r, c)) wrongPixels++;
      }
    }
    check('and every pixel is the module it should be', wrongPixels === 0, String(wrongPixels));
    // The quiet border is not decoration: without it a scanner cannot find
    // the code at all against an email's background.
    let borderInk = 0;
    for (let x = 0; x < width; x++) if (raw[1 + x] !== 255) borderInk++;
    check('the quiet border really is quiet', borderInk === 0);
    check('a pixel buffer of the wrong size is refused',
      (() => { try { greyscalePng(2, 2, new Uint8Array(3)); return false; } catch { return true; } })());
  }

  // -------------------------------------------------------------------------
  // A SCAN THAT RUNS OUT OF TIME.
  //
  // A big, slow site does not fail — it just takes longer than whatever is
  // hosting the scan will allow. Before this the function was killed mid-flight
  // with nothing written down, and the desk spun for ever waiting on a reply
  // that was never coming. Now the scan watches its own clock, stops cleanly,
  // says what it left, and the next scan picks it up.
  console.log('\n— a scan that runs out of time —');
  {
    const SLOW_LISTING = `<!doctype html><html><head><title>Slow — What's on</title></head><body><main>
<a href="/events/slow-one">Slow One</a>
<a href="/events/slow-two">Slow Two</a>
<a href="/events/slow-three">Slow Three</a>
</main></body></html>`;
    const night = (title: string, days: number) => ({
      is_event: true, is_music_event: true, title,
      start_date: new Date(FUTURE.getTime() + days * 86400_000).toISOString().slice(0, 10),
      start_time: '23:00', venue_name: 'The Long Room', city: 'Manchester', country: 'United Kingdom',
      genres: [{ name: 'Techno', confidence: 88 }],
      field_confidence: { title: 90, date: 88, venue: 85, city: 88, genres: 85 },
    });
    const slowFetcher = mockFetcher({
      'https://slow.example/whats-on': { body: SLOW_LISTING },
      'https://slow.example/events/slow-one': { body: '<html><title>Slow One</title><body><main>one</main></body></html>' },
      'https://slow.example/events/slow-two': { body: '<html><title>Slow Two</title><body><main>two</main></body></html>' },
      'https://slow.example/events/slow-three': { body: '<html><title>Slow Three</title><body><main>three</main></body></html>' },
    });
    const slowAI = mockAI({
      'https://slow.example/events/slow-one': night('Slow One', 21),
      'https://slow.example/events/slow-two': night('Slow Two', 22),
      'https://slow.example/events/slow-three': night('Slow Three', 23),
    });
    const src = (await q(
      `insert into event_sources (source_type, name, url)
       values ('promoter_website', 'Slow Site', 'https://slow.example/whats-on') returning id`
    ))[0] as { id: string };

    // No time at all: the clock is already spent when the first link comes up.
    const outOfTime = await scanSource(src.id, { fetcher: slowFetcher, ai: slowAI, delayMs: 1, budgetMs: 0 });
    check('a scan out of time finishes rather than dying', outOfTime.status === 'succeeded');
    check('it still found and recorded the links', outOfTime.candidatesFound === 3 && outOfTime.newCandidates === 3);
    check('it extracted nothing, because it had no time to', outOfTime.extracted === 0);
    check('and it says what it left behind',
      (outOfTime.note ?? '').includes('3 left'), outOfTime.note ?? '(no note)');

    // Seen is not processed: the next scan picks up exactly what was left.
    const rest = await scanSource(src.id, { fetcher: slowFetcher, ai: slowAI, delayMs: 1 });
    check('the next scan carries on where it stopped', rest.extracted === 3);
    check('nothing is new the second time — they were already seen', rest.newCandidates === 0);
    check('and a scan that finished has nothing left to say', rest.note === null, rest.note ?? '');

    // The desk reads the finished row back and gets the same answer.
    const readBack = await getScan(rest.scanId);
    check('the desk can read a finished scan back',
      readBack?.status === 'succeeded' && readBack.extracted === 3 && readBack.running === false);
    check('with the outcomes that explain it', Object.keys(readBack?.outcomes ?? {}).length > 0);
    check('a scan id that does not exist is nothing, not a crash',
      (await getScan('00000000-0000-0000-0000-000000000000')) === null);
  }

  // -------------------------------------------------------------------------
  // A row still calling itself 'running' hours later did not finish — it was
  // killed. Saying so is what lets the desk tell "still working" apart from
  // "gone", instead of spinning on a job nobody is doing.
  console.log('\n— a scan that was killed —');
  {
    const src = (await q(
      `insert into event_sources (source_type, name, url)
       values ('promoter_website', 'Killed Mid-Scan', 'https://killed.example/whats-on') returning id`
    ))[0] as { id: string };
    const scanId = await startScan(src.id);
    await q(`update source_scans set started_at = now() - interval '2 hours' where id = $1`, [scanId]);

    const live = await getScan(scanId);
    check('a scan killed mid-flight is not left running for ever', live?.running === false);
    check('it is reported as failed, and says why',
      live?.status === 'failed' && (live?.error ?? '').includes('stopped before it finished'), live?.error ?? '');

    // A scan that is genuinely still going is left alone.
    const fresh = await startScan(src.id);
    check('a scan that has only just started is still running', (await getScan(fresh))?.running === true);
    check('and the sweep does not touch it', (await sweepStaleScans(src.id)) === 0);
  }

  // -------------------------------------------------------------------------
  console.log('\n— Reading a retreat\'s own page —');
  {
    // What a retreat website actually looks like: OpenGraph tags, a paragraph
    // of marketing, and no date anywhere, because it runs in seasons.
    const RETREAT_URL = 'https://escapespace.example.com/';
    const RETREAT_PAGE = `<!doctype html><html><head>
      <title>Escape Space Zanzibar | Paradise Beyond</title>
      <meta property="og:title" content="Escape Space Zanzibar" />
      <meta property="og:description" content="Seven days on the east coast with nothing on the schedule but the tide. Yoga if you want it, and nobody minds if you do not." />
      <meta property="og:image" content="https://escapespace.example.com/img/beach.jpg" />
      <link rel="canonical" href="https://escapespace.example.com/" />
      </head><body><h1>Escape Space</h1><p>Book a week.</p></body></html>`;

    const out = await readRetreatLink(RETREAT_URL, {
      fetcher: mockFetcher({ [RETREAT_URL]: { body: RETREAT_PAGE } }),
    });
    check('a retreat page with no date at all still reads', out.ok === true);
    if (out.ok) {
      check('the name comes off the page', out.draft.title === 'Escape Space Zanzibar');
      check('so does the picture', out.draft.imageUrl === 'https://escapespace.example.com/img/beach.jpg');
      check('and the description', (out.draft.blurb ?? '').startsWith('Seven days on the east coast'));
      check('the link is the page\'s own canonical', out.draft.url === RETREAT_URL);
      // The whole reason retreats are not events: nothing on the page says
      // when it runs, and we would rather show nothing than invent a date.
      check('when it runs is never invented', out.draft.whenText === null);
      check('and the admin is told what was actually read',
        out.found.includes('title') && out.found.includes('image') && out.found.includes('blurb'));
    }

    // The event pipeline would reject this same page outright — that is the
    // behaviour retreats had to route around, so it is worth pinning down.
    const asEvent = await runExtractionPipeline(RETREAT_URL, {
      fetcher: mockFetcher({ [RETREAT_URL]: { body: RETREAT_PAGE } }), ai: noAI,
    });
    check('the same page is not an event, and the event pipeline says so',
      asEvent.status === 'insufficient_information', asEvent.status);

    const longBlurb = `<!doctype html><html><head><title>Long</title>
      <meta property="og:description" content="${'word '.repeat(120).trim()}" />
      </head><body></body></html>`;
    const trimmed = await readRetreatLink('https://long.example.com/', {
      fetcher: mockFetcher({ 'https://long.example.com/': { body: longBlurb } }),
    });
    check('a page that will not stop talking is cut short',
      trimmed.ok && (trimmed.draft.blurb ?? '').length <= 241 && (trimmed.draft.blurb ?? '').endsWith('\u2026'));
    // Every word in the fixture is "word", so a clean break leaves a whole
    // one before the ellipsis and a mid-word break leaves "wor" or "wo".
    check('and cut at a word, not mid-word',
      trimmed.ok && /(^|\s)word\u2026$/.test(trimmed.draft.blurb ?? ''));

    const missing = await readRetreatLink('https://nothing.example.com/', {
      fetcher: mockFetcher({}),
    });
    check('a page we cannot reach is advice, not a crash',
      !missing.ok && /not found|by hand/i.test(missing.ok ? '' : missing.error));

    // An admin pasting a link is still pasting a URL from outside, so the
    // SSRF guard has to stand in front of this door too.
    const internal = await readRetreatLink('http://169.254.169.254/latest/meta-data/');
    check('an admin cannot make the server read its own metadata service',
      !internal.ok && /allowed to fetch|web address/i.test(internal.ok ? '' : internal.error));
  }

  // -------------------------------------------------------------------------
  console.log('\n\u2014 Picking the picture off a retreat page \u2014');
  {
    // The real failure this fixes: a modern site's og:image is a card the
    // framework DREW — the title, the price and the site's name laid over a
    // gradient. Perfect for WhatsApp, useless on Balance, where the words are
    // already on our card and the picture is supposed to be the place.
    const URL_R = 'https://www.paradise.example.com/experiences/escape-space/';
    const PAGE = `<!doctype html><html><head>
      <meta property="og:title" content="Escape Space Zanzibar" />
      <meta property="og:image" content="https://www.paradise.example.com/experiences/escape-space/opengraph-image?9a1f" />
      </head><body><main>
        <img src="/media/palms-kendwa-1600.jpg" width="1600" height="1000" alt="Palms over the beach at Kendwa" />
        <img src="/media/dhow-sunset-1600.jpg" width="1600" height="1000" alt="A dhow at sunset" />
        <img src="/media/logo.svg" width="240" height="60" alt="Paradise Beyond" />
      </main></body></html>`;

    const out = await readRetreatLink(URL_R, { fetcher: mockFetcher({ [URL_R]: { body: PAGE } }) });
    check('a retreat page reads', out.ok === true);
    if (out.ok) {
      check('the picture chosen is a photograph, not the drawn social card',
        out.draft.imageUrl === 'https://www.paradise.example.com/media/palms-kendwa-1600.jpg', String(out.draft.imageUrl));
      // Demoted, never thrown away: sometimes the card really is the nicest
      // picture on a thin page, and that is the admin's call to make.
      check('the card is still offered, just last',
        out.images.some((u) => u.includes('opengraph-image'))
        && out.images.indexOf(out.images.find((u) => u.includes('opengraph-image'))!) === out.images.length - 1);
      check('every picture on the page is offered, so the first pick is a suggestion',
        out.images.includes('https://www.paradise.example.com/media/dhow-sunset-1600.jpg'));
      check('the logo is not offered as a retreat picture',
        !out.images.some((u) => u.includes('logo')));
    }

    // The shapes frameworks actually generate these at.
    for (const u of [
      'https://x.example.com/a/opengraph-image',
      'https://x.example.com/a/opengraph-image-3f9c2a?v=1',
      'https://x.example.com/a/twitter-image',
      'https://x.example.com/api/og?title=Hello',
      'https://x.example.com/_vercel/og?t=1',
      // The other shape: a card-drawing host serving a hash, no extension.
      'https://opengraph.githubassets.com/9f2c/anthropics/claude-code',
    ]) check(`a drawn card is recognised: ${new URL(u).host}${new URL(u).pathname}`, looksGenerated(u));

    // And the ones that are photographs with unlucky names.
    for (const u of [
      'https://x.example.com/media/ogun-beach.jpg',
      'https://x.example.com/img/dogs-of-kendwa.jpg',
      'https://x.example.com/uploads/2024/og-mandu-cooking.jpg',
      // A card host is only a card host when it is not serving a real file.
      'https://og.example.com/photos/palms-kendwa.jpg',
    ]) check(`a photograph is not mistaken for one: ${new URL(u).host}${new URL(u).pathname}`, !looksGenerated(u));

    // A page with only the drawn card still gives the admin something.
    const THIN = 'https://thin.example.com/';
    const thin = await readRetreatLink(THIN, { fetcher: mockFetcher({ [THIN]: {
      body: `<!doctype html><html><head><meta property="og:title" content="Thin" />
        <meta property="og:image" content="https://thin.example.com/opengraph-image" /></head><body></body></html>` } }) });
    check('a page with nothing but the drawn card still offers it',
      thin.ok && thin.draft.imageUrl === 'https://thin.example.com/opengraph-image');
  }

  // -------------------------------------------------------------------------
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failures:', failures.join(' | '));
    process.exitCode = 1;
  }
  await db.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
