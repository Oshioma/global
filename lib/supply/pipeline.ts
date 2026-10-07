// The Event Supply Engine pipeline:
//
//   URL → validate → safe fetch → structured metadata → AI gap-filling →
//   validation → normalisation → genre mapping → entity matching →
//   duplicate assessment → confidence → moderation/publish decision.
//
// The AI only ever proposes values; every write below goes through
// application validation. All failures land as explicit extraction states —
// nothing is silently swallowed.

import { onEventPublished } from '../alerts';
import { refreshAdminReviewDigest } from '../adminNotify';
import { findOrCreateCity } from '../locations';
import { query, queryOne } from '@/lib/db';
import { normalizeTitle, slugify, EVENT_TYPES } from '@/lib/util';
import { safeFetch, type SafeFetchOptions, type SafeFetchResult } from './safeFetch';
import { inspectPage, type PageInspection } from './structured';
import { defaultAIClient, type AIExtractionClient } from './ai';
import { loadGenres, mapGenreProposals } from './genres';
import { matchOrCreateArtist, matchOrCreatePromoter, matchOrCreateVenue } from './entities';
import { assessDuplicate, type DuplicateAssessment } from './dedupe';
import { computeOverallConfidence, canAutoPublish } from './confidence';
import { inferTimezone, parseFoundDate, resolveEndCrossingMidnight, zonedTimeToUtc } from './time';
import { supplyConfig } from './config';

export type PipelineContext = {
  sourceId?: string | null;
  submissionId?: string | null;
  memberId?: string | null;
  scanKind?: 'submission' | 'source_scan' | 'manual';
  // Reprocessing an existing (non-live) draft updates it in place.
  reprocessEventId?: string | null;
  // Injectables for tests.
  ai?: AIExtractionClient;
  fetcher?: (url: string, opts?: SafeFetchOptions) => Promise<SafeFetchResult>;
  fetchOptions?: SafeFetchOptions;
};

export type PipelineOutcome = {
  extractionId: string;
  status: string;
  eventId: string | null;
  autoPublished: boolean;
  duplicateOf: string | null;
  // Friendly summary for the public submission flow.
  summary: { title: string; date: string | null; city: string | null } | null;
};

type Prov = { conf: Record<string, number>; src: Record<string, string> };

// AI-proposed URLs are untrusted page-derived strings: only absolute
// http(s) URLs survive (blocks javascript:, data:, relative junk).
function sanitizeHttpUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.toString() : null;
  } catch {
    return null;
  }
}

function setProv(p: Prov, field: string, source: string, confidence: number) {
  p.conf[field] = Math.round(confidence);
  p.src[field] = source;
}

async function failExtraction(
  extractionId: string,
  submissionId: string | null | undefined,
  status: string,
  detail: string,
  extra: Record<string, unknown> = {}
): Promise<PipelineOutcome> {
  const cols = Object.keys(extra);
  await query(
    `update extractions set status = $2, failure_detail = $3, updated_at = now()
      ${cols.map((c, i) => `, ${c} = $${i + 4}`).join('')}
      where id = $1`,
    [extractionId, status, detail.slice(0, 500), ...cols.map((c) => extra[c])]
  );
  if (submissionId) {
    await query(
      `update event_submissions set status = 'failed', note = $2, processed_at = now() where id = $1`,
      [submissionId, `${status}: ${detail}`.slice(0, 300)]
    );
  }
  return { extractionId, status, eventId: null, autoPublished: false, duplicateOf: null, summary: null };
}

async function uniqueEventSlug(title: string): Promise<string> {
  const base = slugify(title) || 'event';
  let candidate = base;
  for (let i = 0; i < 50; i++) {
    const clash = await queryOne(`select 1 from events where slug = $1`, [candidate]);
    if (!clash) return candidate;
    candidate = `${base}-${i + 2}`;
  }
  return `${base}-${Math.random().toString(36).slice(2, 8)}`;
}

// Fill only NULL fields on an existing event from a newer extraction
// (multi-source enrichment): provenance is retained via the extraction row
// and the event_source_links entry.
async function enrichExistingEvent(
  eventId: string,
  fields: {
    description?: string | null; short_description?: string | null;
    end_at?: Date | null; primary_image_url?: string | null; ticket_url?: string | null;
    price_from?: number | null; price_to?: number | null; currency?: string | null;
    promoter_id?: string | null; canonical_url?: string | null;
  }
): Promise<string[]> {
  const enriched: string[] = [];
  const updates: string[] = [];
  const args: unknown[] = [eventId];
  for (const [col, val] of Object.entries(fields)) {
    if (val == null) continue;
    args.push(val);
    updates.push(`${col} = coalesce(${col}, $${args.length})`);
    enriched.push(col);
  }
  if (updates.length) {
    await query(`update events set ${updates.join(', ')}, updated_at = now() where id = $1`, args);
  }
  return enriched;
}

export async function runExtractionPipeline(
  rawUrl: string,
  ctx: PipelineContext = {}
): Promise<PipelineOutcome> {
  const startedAt = Date.now();
  const fetcher = ctx.fetcher ?? safeFetch;
  const ai = ctx.ai ?? defaultAIClient();

  const extraction = await queryOne<{ id: string }>(
    `insert into extractions (url, source_id, submission_id) values ($1, $2, $3) returning id`,
    [rawUrl.slice(0, 2000), ctx.sourceId ?? null, ctx.submissionId ?? null]
  );
  const exId = extraction!.id;
  const fail = (status: string, detail: string, extra: Record<string, unknown> = {}) =>
    failExtraction(exId, ctx.submissionId, status, detail, { total_ms: Date.now() - startedAt, ...extra });

  // ---- fetch -------------------------------------------------------------
  const fetched = await fetcher(rawUrl, ctx.fetchOptions);
  if (!fetched.ok) {
    const statusMap: Record<string, string> = {
      invalid_url: 'invalid_url', unsafe_url: 'unsafe_url', fetch_failed: 'fetch_failed',
      not_found: 'not_found', blocked_by_site: 'blocked_by_site', too_large: 'too_large',
      unsupported_content: 'unsupported_content',
    };
    return fail(statusMap[fetched.code] ?? 'failed', fetched.detail, { fetch_ms: fetched.ms });
  }
  const fetchMs = fetched.ms;

  // ---- structured inspection --------------------------------------------
  const extractStarted = Date.now();
  let page: PageInspection;
  try {
    page = inspectPage(fetched.body, fetched.finalUrl, supplyConfig.ai.maxContentChars);
  } catch (err) {
    return fail('failed', `HTML parse error: ${err instanceof Error ? err.message : 'unknown'}`, { fetch_ms: fetchMs });
  }

  const prov: Prov = { conf: {}, src: {} };
  const warnings: string[] = [];

  let title = page.title?.value ?? null;
  if (page.title) setProv(prov, 'title', page.title.source, page.title.confidence);
  let startRaw = page.startAt?.value ?? null;
  let endRaw = page.endAt?.value ?? null;
  if (page.startAt) setProv(prov, 'date', 'json-ld', page.startAt.confidence);
  let venueName = page.venueName?.value ?? null;
  if (page.venueName) setProv(prov, 'venue', page.venueName.source, page.venueName.confidence);
  let venueAddress = page.venueAddress?.value ?? null;
  let city = page.city?.value ?? null;
  if (page.city) setProv(prov, 'city', page.city.source, page.city.confidence);
  let country = page.country?.value ?? null;
  if (page.country) setProv(prov, 'country', page.country.source, page.country.confidence);
  let description = page.description?.value ?? null;
  if (page.description) setProv(prov, 'description', page.description.source, page.description.confidence);
  let imageUrl = page.imageUrl?.value ?? null;
  if (page.imageUrl) setProv(prov, 'image', page.imageUrl.source, page.imageUrl.confidence);
  let ticketUrl = page.ticketUrl?.value ?? null;
  if (page.ticketUrl) setProv(prov, 'ticket_url', page.ticketUrl.source, page.ticketUrl.confidence);
  let priceFrom = page.priceFrom?.value ?? null;
  let priceTo = page.priceTo?.value ?? null;
  let currency = page.currency?.value ?? null;
  if (page.priceFrom || page.priceTo) setProv(prov, 'price', 'json-ld', 90);
  let promoterName = page.organizerName?.value ?? null;
  let promoterSite = page.organizerUrl;
  if (page.organizerName) setProv(prov, 'promoter', page.organizerName.source, page.organizerName.confidence);
  let artistNames: string[] = page.performers.slice(0, 60);
  if (artistNames.length) setProv(prov, 'lineup', 'json-ld', 90);
  let explicitTz: string | null = null;
  let shortDescription: string | null = null;
  let eventTypeValue: string | null = null;
  if (page.eventTypeHint === 'Festival') {
    eventTypeValue = 'festival';
    setProv(prov, 'event_type', 'json-ld', 85);
  }

  // schema.org Event.genre values are strong signals — seed them ahead of
  // any AI proposals so structured data wins in the mapping.
  const genreProposals: { name: string; confidence: number }[] = page.genres.map((name) => ({
    name,
    confidence: 90,
  }));
  const listingHint = page.eventStatusHint;
  if (listingHint) warnings.push(`page marks event as ${listingHint} (schema.org eventStatus)`);

  // ---- AI gap-filling ----------------------------------------------------
  let aiUsed = false;
  let aiModel: string | null = null;
  let aiTokensIn: number | null = null;
  let aiTokensOut: number | null = null;
  let aiSaidNotEvent = false;
  let aiSaidNotMusic: boolean | null = null;

  if (ai.available) {
    const taxonomy = await loadGenres();
    const outcome = await ai.extract({
      url: fetched.finalUrl,
      pageText: page.cleanedText,
      knownFields: {
        title, start: startRaw, end: endRaw, venue: venueName, city, country,
        artists: artistNames, ticket_url: ticketUrl,
      },
      genreVocabulary: taxonomy.map((g) => g.name),
    });
    aiUsed = true;
    if (!outcome.ok) {
      if (outcome.error === 'unavailable') {
        aiUsed = false;
      } else if (title && startRaw) {
        // Structured data alone can still make a reviewable draft.
        warnings.push(`AI extraction failed (${outcome.error}); structured data only`);
      } else {
        return fail('ai_extraction_failed', `${outcome.error}: ${outcome.detail}`, {
          fetch_ms: fetchMs, extract_ms: Date.now() - extractStarted,
          structured_data_found: page.structuredDataFound, ai_used: true,
        });
      }
    } else {
      const p = outcome.proposal;
      aiModel = outcome.model;
      aiTokensIn = outcome.inputTokens;
      aiTokensOut = outcome.outputTokens;
      aiSaidNotEvent = !p.is_event;
      aiSaidNotMusic = p.is_music_event == null ? null : !p.is_music_event;

      const aiConf = (field: string, fallback: number) =>
        Math.min(p.field_confidence[field] ?? fallback, 90); // AI never outranks structured data

      // Structured values win; AI fills the gaps.
      if (!title && p.title) { title = p.title; setProv(prov, 'title', 'ai', aiConf('title', 70)); }
      if (!startRaw && p.start_date) {
        startRaw = p.start_time ? `${p.start_date}T${p.start_time}` : p.start_date;
        setProv(prov, 'date', 'ai', aiConf('date', 65));
        if (p.start_time) setProv(prov, 'start_time', 'ai', aiConf('start_time', 60));
      }
      if (!endRaw && p.end_date) {
        endRaw = p.end_time ? `${p.end_date}T${p.end_time}` : p.end_date;
        setProv(prov, 'end_time', 'ai', aiConf('end_time', 55));
      } else if (!endRaw && p.end_time && startRaw) {
        endRaw = `SAME_DAY_TIME:${p.end_time}`;
        setProv(prov, 'end_time', 'ai', aiConf('end_time', 55));
      }
      if (!venueName && p.venue_name) { venueName = p.venue_name; setProv(prov, 'venue', 'ai', aiConf('venue', 65)); }
      if (!venueAddress && p.venue_address) venueAddress = p.venue_address;
      if (!city && p.city) { city = p.city; setProv(prov, 'city', 'ai', aiConf('city', 65)); }
      if (!country && p.country) { country = p.country; setProv(prov, 'country', 'ai', aiConf('country', 60)); }
      if (!promoterName && p.promoter_name) {
        promoterName = p.promoter_name;
        promoterSite ||= sanitizeHttpUrl(p.promoter_website);
        setProv(prov, 'promoter', 'ai', aiConf('promoter', 60));
      }
      if (!artistNames.length && p.artists.length) {
        artistNames = p.artists.slice(0, 60);
        setProv(prov, 'lineup', 'ai', aiConf('artists', 60));
      }
      if (!description && p.description) { description = p.description; setProv(prov, 'description', 'ai', 60); }
      if (!shortDescription && p.short_description) shortDescription = p.short_description;
      const safeImage = sanitizeHttpUrl(p.image_url);
      if (!imageUrl && safeImage) { imageUrl = safeImage; setProv(prov, 'image', 'ai', aiConf('image', 55)); }
      const safeTicket = sanitizeHttpUrl(p.ticket_url);
      if (!ticketUrl && safeTicket) { ticketUrl = safeTicket; setProv(prov, 'ticket_url', 'ai', aiConf('ticket_url', 60)); }
      if (priceFrom == null && p.price_from != null) {
        priceFrom = p.price_from;
        priceTo = p.price_to;
        currency ||= p.currency;
        setProv(prov, 'price', 'ai', aiConf('price', 55));
      }
      if (p.timezone) explicitTz = p.timezone;
      if (!eventTypeValue && p.event_type && EVENT_TYPES.some((t) => t.value === p.event_type)) {
        eventTypeValue = p.event_type;
        setProv(prov, 'event_type', 'ai', 70);
      }
      genreProposals.push(...p.genres);
      warnings.push(...p.notes.map((n) => `AI note: ${n}`.slice(0, 300)));
    }
  }
  if (!aiUsed) {
    warnings.push(
      page.genres.length
        ? 'AI unavailable — structured data only'
        : 'AI unavailable — structured data only, genres not classified'
    );
  }

  // ---- is it an event at all? -------------------------------------------
  if (aiSaidNotEvent && !page.structuredDataFound) {
    return fail('not_an_event', 'Page does not describe a single event', {
      fetch_ms: fetchMs, extract_ms: Date.now() - extractStarted,
      structured_data_found: false, ai_used: aiUsed, ai_model: aiModel,
      ai_input_tokens: aiTokensIn, ai_output_tokens: aiTokensOut,
    });
  }

  // ---- required fields ---------------------------------------------------
  const metricsExtra = {
    fetch_ms: fetchMs,
    structured_data_found: page.structuredDataFound,
    ai_used: aiUsed, ai_model: aiModel,
    ai_input_tokens: aiTokensIn, ai_output_tokens: aiTokensOut,
    canonical_url: page.canonicalUrl,
  };
  if (!title) {
    return fail('insufficient_information', 'No reliable title found', {
      ...metricsExtra, extract_ms: Date.now() - extractStarted,
    });
  }
  if (!startRaw) {
    return fail('insufficient_information', 'No reliable event date found', {
      ...metricsExtra, extract_ms: Date.now() - extractStarted,
    });
  }

  // ---- date normalisation (event's own timezone, never the admin's) -----
  const tz = inferTimezone(country, explicitTz);
  if (tz.inferred && !country) warnings.push('timezone assumed Europe/London (no location evidence)');
  const startParsed = parseFoundDate(startRaw, tz.timezone);
  if (!startParsed) {
    return fail('invalid_date', `Unparseable start "${startRaw}"`, {
      ...metricsExtra, extract_ms: Date.now() - extractStarted,
    });
  }
  const startAt = startParsed.date;
  if (startParsed.dateOnly) {
    warnings.push('start time unknown (date only)');
    prov.conf.start_time = 0;
  }
  let endAt: Date | null = null;
  if (endRaw) {
    if (endRaw.startsWith('SAME_DAY_TIME:')) {
      const [hh, mm] = endRaw.slice('SAME_DAY_TIME:'.length).split(':').map(Number);
      const sameDay = new Date(startAt);
      // Interpret the end wall-clock on the start's local date, then roll
      // across midnight if needed.
      const local = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz.timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      }).format(sameDay);
      const [y, m, d] = local.split('-').map(Number);
      endAt = resolveEndCrossingMidnight(startAt, zonedTimeToUtc(y, m, d, hh, mm, tz.timezone));
    } else {
      const endParsed = parseFoundDate(endRaw, tz.timezone);
      if (endParsed) {
        endAt = endParsed.dateOnly
          ? zonedTimeToUtc(
              endParsed.date.getUTCFullYear(), endParsed.date.getUTCMonth() + 1,
              endParsed.date.getUTCDate(), 23, 59, tz.timezone
            )
          : endParsed.date;
        if (endParsed.dateOnly) warnings.push('end time approximate (end date only)');
        endAt = resolveEndCrossingMidnight(startAt, endAt);
        if (endAt.getTime() <= startAt.getTime()) {
          warnings.push('end time before start — discarded');
          endAt = null;
        }
      }
    }
  }
  if (startAt.getTime() < Date.now() - 86400_000) warnings.push('event date is in the past');

  // ALREADY OVER: a listing page full of last month's nights is the commonest
  // thing a scan reads, and every one used to land in Needs Review for an
  // admin to step over. Nobody can go to it, so it is recorded and dropped
  // here, before a venue or promoter is created on its account. Reprocessing
  // an event an admin is already holding is left alone.
  const finishesAt = endAt ?? new Date(startAt.getTime() + 6 * 3600_000);
  if (!ctx.reprocessEventId && finishesAt.getTime() <= Date.now()) {
    return fail('event_finished', 'The event has already happened', {
      ...metricsExtra,
      payload: JSON.stringify({ title, start_at: startAt.toISOString(), city, country }),
    });
  }

  // ---- genre mapping -----------------------------------------------------
  const taxonomy = await loadGenres();
  const mapping = mapGenreProposals(genreProposals, taxonomy);
  if (mapping.matched.length) {
    setProv(prov, 'genres', page.genres.length ? 'json-ld' : 'ai',
      Math.round(mapping.matched.reduce((s, m) => s + m.confidence, 0) / mapping.matched.length));
  }
  for (const u of mapping.unknown) {
    warnings.push(`UNKNOWN GENRE SUGGESTION: "${u.name}" (${Math.round(u.confidence)}%)`);
  }

  // ---- relevance ---------------------------------------------------------
  const extractMs = Date.now() - extractStarted;
  if (mapping.matched.length === 0 && aiSaidNotMusic === true) {
    return fail('not_relevant', 'Not an electronic-music event within the Guestlist remit', {
      ...metricsExtra, extract_ms: extractMs, relevance: 'not_relevant',
      payload: JSON.stringify({ title, start_at: startAt.toISOString(), city, country }),
    });
  }
  const relevance = mapping.matched.length > 0 ? 'relevant' : 'unknown';

  // ---- entity matching ---------------------------------------------------
  let venueId: string | null = null;
  if (venueName) {
    const match = await matchOrCreateVenue({
      name: venueName, address: venueAddress, city, country,
    });
    venueId = match.id;
    if (match.warning) warnings.push(match.warning);
    if (!match.created) prov.src.venue = 'entity-match';
  }
  let promoterId: string | null = null;
  if (promoterName) {
    const match = await matchOrCreatePromoter({ name: promoterName, website: promoterSite });
    promoterId = match.id;
    if (!match.created) prov.src.promoter = 'entity-match';
  }
  const artistIds: string[] = [];
  for (const name of artistNames) {
    const match = await matchOrCreateArtist(name);
    artistIds.push(match.id);
  }

  // ---- duplicate assessment ---------------------------------------------
  const dup: DuplicateAssessment = await assessDuplicate({
    title, startAt, city, venueId, promoterId, artistNames,
    sourceUrl: fetched.finalUrl, canonicalUrl: page.canonicalUrl, ticketUrl,
    excludeEventId: ctx.reprocessEventId ?? null,
  });

  const linkKind = ctx.scanKind ?? (ctx.submissionId ? 'submission' : 'manual');

  if (dup.state === 'exact' && !ctx.reprocessEventId) {
    // Same event, new evidence: link the source, enrich missing fields.
    await query(
      `insert into event_source_links (event_id, source_id, extraction_id, url, kind)
       values ($1, $2, $3, $4, $5) on conflict (event_id, url) do nothing`,
      [dup.eventId, ctx.sourceId ?? null, exId, fetched.finalUrl, linkKind]
    );
    const enriched = await enrichExistingEvent(dup.eventId!, {
      description, short_description: shortDescription, end_at: endAt,
      primary_image_url: imageUrl, ticket_url: ticketUrl,
      price_from: priceFrom, price_to: priceTo, currency,
      promoter_id: promoterId, canonical_url: page.canonicalUrl,
    });
    await query(
      `update extractions set status = 'duplicate_linked', event_id = $2,
              duplicate_state = 'exact', duplicate_score = 100, duplicate_of = $2,
              field_confidence = $3, field_sources = $4, warnings = $5,
              relevance = $6, extract_ms = $7, total_ms = $8, updated_at = now(),
              fetch_ms = $9, structured_data_found = $10, ai_used = $11, ai_model = $12,
              ai_input_tokens = $13, ai_output_tokens = $14, canonical_url = $15,
              failure_detail = $16
        where id = $1`,
      [
        exId, dup.eventId, JSON.stringify(prov.conf), JSON.stringify(prov.src),
        JSON.stringify(warnings), relevance, extractMs, Date.now() - startedAt,
        fetchMs, page.structuredDataFound, aiUsed, aiModel, aiTokensIn, aiTokensOut,
        page.canonicalUrl, enriched.length ? `enriched: ${enriched.join(', ')}` : null,
      ]
    );
    if (ctx.submissionId) {
      await query(
        `update event_submissions set status = 'duplicate', event_id = $2, processed_at = now() where id = $1`,
        [ctx.submissionId, dup.eventId]
      );
    }
    return {
      extractionId: exId, status: 'duplicate_linked', eventId: dup.eventId,
      autoPublished: false, duplicateOf: dup.eventId, summary: null,
    };
  }

  // ---- confidence + publish decision ------------------------------------
  const sourceTrust = ctx.sourceId
    ? (await queryOne<{ trust: string }>(`select trust from event_sources where id = $1`, [ctx.sourceId]))?.trust ?? 'new'
    : null;
  const overall = computeOverallConfidence(prov.conf, sourceTrust);
  const auto = canAutoPublish({
    sourceTrust, overallConfidence: overall, fieldConfidence: prov.conf,
    startAt, hasLocation: !!(venueId || city), mappedGenreCount: mapping.matched.length,
    duplicateState: dup.state, warnings,
  });

  let eventStatus: 'live' | 'new' | 'needs_review';
  if (auto.ok) eventStatus = 'live';
  else if (dup.state !== 'none' || mapping.unknown.length || relevance === 'unknown' ||
           warnings.some((w) => /venue matched by name only|past|timezone assumed/i.test(w))) {
    eventStatus = 'needs_review';
  } else eventStatus = 'new';

  // ---- write the event (application-controlled, validated values only) --
  let eventId: string;
  if (ctx.reprocessEventId) {
    const existing = await queryOne<{ id: string; status: string }>(
      `select id, status from events where id = $1`, [ctx.reprocessEventId]
    );
    if (!existing) return fail('failed', 'Reprocess target no longer exists', metricsExtra);
    if (existing.status === 'live') return fail('failed', 'Cannot reprocess a live event — unpublish first', metricsExtra);
    eventId = existing.id;
    await query(
      `update events set title=$2, short_description=$3, description=$4, start_at=$5, end_at=$6,
              timezone=$7, venue_id=$8, promoter_id=$9, city=$10, country=$11, event_type=$12,
              ticket_url=$13, price_from=$14, price_to=$15, currency=$16, primary_image_url=$17,
              canonical_url=$18, confidence_score=$19,
              possible_duplicate_of=$20, title_normalized=$21, status=$22::event_status,
              listing_status=$23, updated_at=now()
        where id=$1`,
      [
        eventId, title, shortDescription, description, startAt, endAt, tz.timezone,
        venueId, promoterId, city, country, eventTypeValue ?? 'other', ticketUrl,
        priceFrom, priceTo, currency, imageUrl, page.canonicalUrl, overall,
        dup.state !== 'none' ? dup.eventId : null, normalizeTitle(title),
        eventStatus === 'live' ? 'needs_review' : eventStatus, // reprocess never auto-publishes
        listingHint ?? 'confirmed',
      ]
    );
    await query(`delete from event_genres where event_id = $1 and source in ('ai','import')`, [eventId]);
    await query(`delete from event_artists where event_id = $1`, [eventId]);
  } else {
    const slug = await uniqueEventSlug(title);
    const row = await queryOne<{ id: string }>(
      `insert into events (title, slug, short_description, description, start_at, end_at,
          timezone, venue_id, promoter_id, city, country, event_type, ticket_url,
          price_from, price_to, currency, primary_image_url, source_url, canonical_url,
          source_type, source_id, status, confidence_score, possible_duplicate_of,
          title_normalized, listing_status, published_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,
          $20::source_type,$21,$22::event_status,$23,$24,$25,$26,
          case when $22::event_status = 'live' then now() end)
       returning id`,
      [
        title, slug, shortDescription, description, startAt, endAt, tz.timezone,
        venueId, promoterId, city, country, eventTypeValue ?? 'other', ticketUrl,
        priceFrom, priceTo, currency, imageUrl, fetched.finalUrl, page.canonicalUrl,
        ctx.sourceId ? 'other' : 'member_submission', ctx.sourceId ?? null,
        eventStatus, overall, dup.state !== 'none' ? dup.eventId : null, normalizeTitle(title),
        listingHint ?? 'confirmed',
      ]
    );
    eventId = row!.id;
    if (!ctx.sourceId) {
      // A member pasted this in and is now waiting on a person, so the admin
      // review count moves immediately. A SCAN does not do this per event —
      // it refreshes once for the whole run (see scanDueSources), because
      // fifty events arriving is still one thing that happened.
      await refreshAdminReviewDigest();
    }
    if (ctx.sourceId) {
      // Reflect the source's own type on the event, and attribute the
      // event to the source's promoter when extraction found none — a
      // promoter's connected website feeds their own events.
      await query(
        `update events set source_type = s.source_type,
                promoter_id = coalesce(events.promoter_id, s.promoter_id)
           from event_sources s
          where events.id = $1 and s.id = $2`,
        [eventId, ctx.sourceId]
      );
    }
  }

  for (const m of mapping.matched) {
    await query(
      `insert into event_genres (event_id, genre_id, source, confidence)
       values ($1, $2, 'ai', $3) on conflict (event_id, genre_id) do update set confidence = excluded.confidence`,
      [eventId, m.genre.id, m.confidence]
    );
  }
  for (let i = 0; i < artistIds.length; i++) {
    await query(
      `insert into event_artists (event_id, artist_id, position, billing)
       values ($1, $2, $3, $4) on conflict do nothing`,
      [eventId, artistIds[i], i, i === 0 ? 'headliner' : null]
    );
  }
  if (imageUrl) {
    await query(
      `insert into event_images (event_id, url, sort_order)
       select $1, $2, 0 where not exists (select 1 from event_images where event_id = $1 and url = $2)`,
      [eventId, imageUrl]
    );
  }
  await query(
    `insert into event_source_links (event_id, source_id, extraction_id, url, kind)
     values ($1, $2, $3, $4, $5) on conflict (event_id, url) do nothing`,
    [eventId, ctx.sourceId ?? null, exId, fetched.finalUrl, linkKind]
  );
  for (const u of mapping.unknown) {
    await query(
      `insert into genre_suggestions (extraction_id, event_id, suggested_name, confidence)
       values ($1, $2, $3, $4)`,
      [exId, eventId, u.name, u.confidence]
    );
  }

  const payload = {
    title, short_description: shortDescription, description,
    start_at: startAt.toISOString(), end_at: endAt?.toISOString() ?? null,
    timezone: tz.timezone,
    venue: venueName ? { name: venueName, address: venueAddress, city, country } : null,
    city, country,
    promoter: promoterName ? { name: promoterName, website: promoterSite } : null,
    artists: artistNames.map((name, i) => ({ name, billing_order: i + 1 })),
    genres: mapping.matched.map((m) => ({ name: m.genre.name, confidence: m.confidence })),
    event_type: eventTypeValue, ticket_url: ticketUrl, image_url: imageUrl,
    price_from: priceFrom, price_to: priceTo, currency,
    source_url: fetched.finalUrl, canonical_url: page.canonicalUrl,
  };

  await query(
    `update extractions set status = $2, event_id = $3, payload = $4,
            field_confidence = $5, field_sources = $6, warnings = $7,
            overall_confidence = $8, relevance = $9,
            duplicate_state = $10, duplicate_score = $11, duplicate_of = $12,
            structured_data_found = $13, ai_used = $14, ai_model = $15,
            ai_input_tokens = $16, ai_output_tokens = $17,
            fetch_ms = $18, extract_ms = $19, total_ms = $20,
            canonical_url = $21, updated_at = now()
      where id = $1`,
    [
      exId, dup.state !== 'none' ? 'possible_duplicate' : 'succeeded', eventId,
      JSON.stringify(payload), JSON.stringify(prov.conf), JSON.stringify(prov.src),
      JSON.stringify(warnings), overall, relevance,
      dup.state, dup.score || null, dup.eventId,
      page.structuredDataFound, aiUsed, aiModel, aiTokensIn, aiTokensOut,
      fetchMs, extractMs, Date.now() - startedAt, page.canonicalUrl,
    ]
  );
  if (ctx.submissionId) {
    await query(
      `update event_submissions set status = 'processed', event_id = $2, processed_at = now() where id = $1`,
      [ctx.submissionId, eventId]
    );
  }

  // Canonical location linkage (city pages, travel/home-city alerts).
  if (city) {
    try {
      const loc = await findOrCreateCity({ name: city, countryName: country ?? null, timezone: tz.timezone });
      await query(`update events set location_id = $2 where id = $1`, [eventId, loc.id]);
    } catch (err) {
      console.error('location link failed', err);
    }
  }
  // Auto-published events trigger the member alert engine (fire-and-forget).
  if (eventStatus === 'live') void onEventPublished(eventId);

  return {
    extractionId: exId,
    status: dup.state !== 'none' ? 'possible_duplicate' : 'succeeded',
    eventId,
    autoPublished: eventStatus === 'live',
    duplicateOf: dup.eventId,
    summary: {
      title,
      date: startAt.toISOString(),
      city: city ?? venueName,
    },
  };
}
