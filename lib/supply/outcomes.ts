// Why a scan produced no events.
//
// The pipeline records a precise status for every page it tries, but the
// scan summary only ever showed a count — so "5 candidates · 0 extracted"
// gave an admin nothing to act on. These are those statuses in plain
// English, with the thing to actually do about each one.
//
// Pure, so both the workbench and the source table render the same words.

export type OutcomeTally = Record<string, number>;

const MEANING: Record<string, string> = {
  succeeded: 'read as an event',
  possible_duplicate: 'read, but looks like an event we already have',
  duplicate_linked: 'already in Guestlist — linked to this source',
  not_an_event: 'not an event page (a listing index, a ticket shop, an article)',
  not_relevant: 'an event, but not music we cover',
  event_finished: 'an event that has already happened',
  insufficient_information: 'an event page, but no usable date on it',
  invalid_date: 'a date we could not make sense of',
  ai_extraction_failed: 'the AI reader failed — check ANTHROPIC_API_KEY and the model name',
  blocked_by_site: 'the site refused our request',
  fetch_failed: 'the page could not be fetched',
  not_found: 'the page has gone (404)',
  too_large: 'the page was too big to read',
  unsupported_content: 'not a web page we can read (a PDF, an image)',
  unsafe_url: 'a URL we refuse to fetch',
  invalid_url: 'not a valid URL',
  failed: 'failed for an unrecorded reason',
  processing: 'still being read',
};

export function outcomeLabel(status: string): string {
  return MEANING[status] ?? status.replace(/_/g, ' ');
}

// One sentence naming what dominated the scan, so an admin reads a cause
// rather than a table of counts.
export function explainScan(o: OutcomeTally | undefined | null, extracted: number): string | null {
  const entries = Object.entries(o ?? {}).filter(([s]) => s !== 'succeeded' && s !== 'possible_duplicate');
  if (!entries.length) return null;
  const total = entries.reduce((n, [, c]) => n + c, 0);
  if (!total) return null;
  const [status, count] = entries.sort((a, b) => b[1] - a[1])[0];

  // The most common disappointment by far: the source URL is a homepage, so
  // the "event links" on it were navigation.
  if (status === 'not_an_event' && extracted === 0) {
    return `None of those links were event pages — ${count} read as ${outcomeLabel(status)}. This usually means the source URL is a homepage rather than its what's-on page.`;
  }
  return `${count} of ${total} ${count === 1 ? 'was' : 'were'} ${outcomeLabel(status)}.`;
}

export function outcomeBreakdown(o: OutcomeTally | undefined | null): { status: string; count: number; label: string }[] {
  return Object.entries(o ?? {})
    .sort((a, b) => b[1] - a[1])
    .map(([status, count]) => ({ status, count, label: outcomeLabel(status) }));
}
