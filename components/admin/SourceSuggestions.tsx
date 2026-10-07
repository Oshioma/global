'use client';

// THIS MONTH'S SUGGESTIONS: five drum & bass, five house and five hip hop
// promoters or clubs a month, found by the monthly job
// (/api/jobs/suggest-sources). Each one is added as a source that is NOT
// polling, and scanned, so what shows here is the events it actually lists.
//
// Tick POLL and it goes on the schedule and its upcoming events are published
// — no trip to the workbench. DISMISS deletes it and anything only it brought
// in. Until one or the other, its events stay out of the review queues.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { fmtDate, sourceTypeLabel } from '@/lib/util';
import { startAndWatchScan } from '@/lib/supply/watchScan';
import { explainScan } from '@/lib/supply/outcomes';

export type SuggestionEvent = {
  id: string;
  title: string;
  start_at: string;
  timezone: string;
  city: string | null;
  duplicate: boolean;
};

export type SuggestionRow = {
  id: string;
  batch_month: string;
  genre_key: string;
  name: string;
  url: string;
  kind: string;
  city: string | null;
  country: string | null;
  note: string | null;
  candidates: number | null;
  verdict: string | null;
  status: 'pending' | 'added' | 'dismissed';
  source_id: string | null;
  polling: boolean;
  // The source's latest scan: null when it has never been scanned.
  scan_status: 'running' | 'succeeded' | 'failed' | null;
  scan_error: string | null;
  scanned_at: string | null;
  upcoming: number;
  events: SuggestionEvent[];
};

const BUCKETS = [
  { key: 'dnb', label: 'Drum & Bass' },
  { key: 'house', label: 'House' },
  { key: 'hiphop', label: 'Hip Hop' },
];

type RowState = { busy: boolean; error: string; scanning: boolean; scanNote: string; done: string };
const blank = (): RowState => ({ busy: false, error: '', scanning: false, scanNote: '', done: '' });

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function SourceSuggestions({
  month, suggestions, extraCountries, sourceCountries,
}: {
  month: string;
  suggestions: SuggestionRow[];
  extraCountries: string[];
  sourceCountries: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(suggestions.some((s) => s.status === 'pending' || (s.status === 'added' && !s.polling)));
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState('');
  const [countryError, setCountryError] = useState('');
  const [savingCountry, setSavingCountry] = useState(false);

  const setRow = (id: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? blank()), ...patch } }));

  const undecided = (s: SuggestionRow) => s.status === 'pending' || (s.status === 'added' && !s.polling);
  const pending = suggestions.filter(undecided).length;
  const thisMonth = suggestions.filter((s) => s.batch_month === month);

  async function decide(s: SuggestionRow, action: 'poll' | 'dismiss') {
    if (action === 'dismiss' && s.upcoming > 0 &&
        !window.confirm(`Dismiss ${s.name}? Its ${plural(s.upcoming, 'unpublished event')} will be deleted too.`)) {
      return;
    }
    setRow(s.id, { busy: true, error: '' });
    try {
      const res = await fetch(`/api/admin/sources/suggestions/${s.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRow(s.id, {
          busy: false,
          done: action === 'poll'
            ? `Polling — published ${plural(data.published ?? 0, 'event')}.`
            : data.deletedEvents ? `Dismissed, and ${plural(data.deletedEvents, 'event')} removed.` : 'Dismissed.',
        });
        router.refresh();
      } else {
        setRow(s.id, { busy: false, error: data?.error ?? 'Could not save' });
      }
    } catch {
      setRow(s.id, { busy: false, error: 'Could not reach the server' });
    }
  }

  // Normally the scheduled scan gets there first; this is for not waiting.
  async function scan(s: SuggestionRow) {
    if (!s.source_id) return;
    setRow(s.id, { scanning: true, error: '', scanNote: 'Scanning…' });
    const out = await startAndWatchScan(s.source_id, (note) =>
      setRow(s.id, { scanNote: note ? `Scanning… ${note}` : 'Scanning…' }));
    if (!out.ok) {
      setRow(s.id, { scanning: false, scanNote: '', error: out.error });
      return;
    }
    const r = out.scan;
    setRow(s.id, {
      scanning: false,
      scanNote: '',
      error: r.status === 'failed' ? (r.error ?? 'Scan failed') : '',
    });
    router.refresh();
  }

  async function findMore() {
    setRunning(true);
    setRunNote('');
    try {
      const res = await fetch('/api/jobs/suggest-sources', { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const added = (data.buckets ?? []).reduce((n: number, b: { added: number }) => n + b.added, 0);
        const errors: string[] = (data.buckets ?? []).flatMap((b: { errors: string[] }) => b.errors);
        const scanned = data.scanned ? ` Scanned ${plural(data.scanned, 'suggestion')}.` : '';
        setRunNote(
          added
            ? `Found ${added} more.${scanned}${data.outOfTime ? ' Ran out of time — press again to carry on.' : ''}`
            : errors.length
              ? `Nothing new — ${errors[0]}${scanned}`
              : data.outOfTime
                ? `Ran out of time before finding any — press again to carry on.${scanned}`
                : `Nothing new to find: every genre is full for the month, or no place had a site that passed the test.${scanned}`
        );
        router.refresh();
      } else {
        setRunNote(data?.error ?? 'Search failed');
      }
    } catch {
      setRunNote('Could not reach the server — try again');
    } finally {
      setRunning(false);
    }
  }

  async function addCountry(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const country = String(new FormData(form).get('country') ?? '').trim();
    if (!country) { setCountryError('Enter a country'); return; }
    setSavingCountry(true);
    setCountryError('');
    try {
      const res = await fetch('/api/admin/sources/suggestions/countries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        form.reset();
        router.refresh();
      } else {
        setCountryError(data?.error ?? 'Could not add');
      }
    } catch {
      setCountryError('Could not reach the server');
    } finally {
      setSavingCountry(false);
    }
  }

  async function removeCountry(country: string) {
    await fetch('/api/admin/sources/suggestions/countries', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ country }),
    }).catch(() => null);
    router.refresh();
  }

  // What the scan found, in words, for a suggestion still waiting on a
  // decision.
  function foundLine(s: SuggestionRow, r: RowState) {
    if (r.scanning) return r.scanNote || 'Scanning…';
    if (s.scan_status === null) return 'Not scanned yet — the next scheduled scan will pick it up.';
    if (s.scan_status === 'running') return 'Scanning now…';
    if (s.scan_status === 'failed') return `Scan failed${s.scan_error ? `: ${s.scan_error}` : ''}.`;
    if (s.upcoming === 0) return 'Scanned — no upcoming events found on it.';
    return `Found ${plural(s.upcoming, 'upcoming event')}:`;
  }

  return (
    <div className="discoverPanel" id="suggestions">
      <div className="discoverHead">
        <div>
          <strong>This month&rsquo;s suggestions{pending > 0 ? ` (${pending} to decide)` : ''}</strong>
          <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
            Every month: 5 drum &amp; bass, 5 house and 5 hip hop promoters or clubs that aren&rsquo;t
            sources yet — drum &amp; bass and house from your countries, hip hop from US cities. Each
            one is scanned for you, so you can see the events it lists. Tick <b>Poll</b> to keep it:
            it goes on the schedule and those events are published. Its events stay out of the
            review queue until you decide.
          </div>
        </div>
        <button className="btnGhost" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Show'}
        </button>
      </div>

      {open && (
        <>
          {BUCKETS.map((b) => {
            const list = suggestions.filter((s) => s.genre_key === b.key);
            const monthCount = thisMonth.filter((s) => s.genre_key === b.key).length;
            return (
              <div key={b.key} style={{ marginTop: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: 1, textTransform: 'uppercase' }}>
                  {b.label} <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}>· {monthCount}/5 this month</span>
                </div>
                {list.length === 0 ? (
                  <p style={{ color: 'var(--text-faint)', fontSize: 12.5, margin: '6px 0 0' }}>
                    None yet this month.
                  </p>
                ) : (
                  <div className="adminTableWrap" style={{ marginTop: 6 }}>
                    <table className="adminTable">
                      <tbody>
                        {list.map((s) => {
                          const r = rows[s.id] ?? blank();
                          // Still to decide — or added before Poll existed and never put
                          // on the schedule, which gets the same choice.
                          const isPending = s.status === 'pending' || (s.status === 'added' && !s.polling);
                          const canDismiss = s.status === 'pending';
                          return (
                            <tr key={s.id} style={s.status === 'dismissed' ? { opacity: 0.5 } : undefined}>
                              <td style={{ minWidth: 200 }}>
                                <strong>{s.name}</strong>
                                <div style={{ fontSize: 11.5 }}>
                                  <a href={s.url} target="_blank" rel="noopener noreferrer"
                                     style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>
                                    {s.url}
                                  </a>
                                </div>
                                <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>
                                  {sourceTypeLabel(s.kind)} · {[s.city, s.country].filter(Boolean).join(', ') || '—'}
                                </div>
                                {s.note && (
                                  <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{s.note}</div>
                                )}
                              </td>
                              <td style={{ fontSize: 12, minWidth: 260, color: 'var(--text-soft)' }}>
                                {isPending ? (
                                  <>
                                    <div style={s.scan_status === 'failed' ? { color: 'var(--danger)' } : undefined}>
                                      {foundLine(s, r)}
                                    </div>
                                    {!r.scanning && s.events.length > 0 && (
                                      <ul style={{ margin: '4px 0 0', paddingLeft: 16, lineHeight: 1.55 }}>
                                        {s.events.map((e) => (
                                          <li key={e.id}>
                                            <a href={`/admin/events/${e.id}`} style={{ textDecoration: 'underline' }}>
                                              {e.title}
                                            </a>
                                            <span style={{ color: 'var(--text-faint)' }}>
                                              {' '}· {fmtDate(e.start_at, e.timezone, { weekday: 'short', day: 'numeric', month: 'short' })}{e.city ? ` · ${e.city}` : ''}
                                              {e.duplicate ? ' · possible duplicate, stays in review' : ''}
                                            </span>
                                          </li>
                                        ))}
                                        {s.upcoming > s.events.length && (
                                          <li style={{ color: 'var(--text-faint)' }}>
                                            and {s.upcoming - s.events.length} more
                                          </li>
                                        )}
                                      </ul>
                                    )}
                                    {s.scan_status === 'succeeded' && s.upcoming === 0 && s.scanned_at && (
                                      <div style={{ color: 'var(--text-faint)', fontSize: 11.5, marginTop: 2 }}>
                                        {s.verdict}
                                      </div>
                                    )}
                                  </>
                                ) : s.status === 'added' ? (
                                  <span>Polling ✓{s.upcoming ? ` · ${plural(s.upcoming, 'upcoming event')}` : ''}</span>
                                ) : (
                                  <span style={{ color: 'var(--text-faint)' }}>Dismissed</span>
                                )}
                                {r.done && <div style={{ marginTop: 4 }}>{r.done}</div>}
                                {r.error && <div style={{ color: 'var(--danger)', marginTop: 4 }}>{r.error}</div>}
                              </td>
                              <td style={{ whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                                {isPending && (
                                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}>
                                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, margin: 0,
                                                    fontSize: 12.5, fontWeight: 700, cursor: 'pointer' }}>
                                      <input
                                        type="checkbox"
                                        checked={false}
                                        disabled={r.busy}
                                        onChange={() => decide(s, 'poll')}
                                        aria-label={`Poll ${s.name}`}
                                      />
                                      {r.busy ? 'Saving…' : 'Poll'}
                                    </label>
                                    <div style={{ display: 'flex', gap: 6 }}>
                                      {(s.scan_status === null || s.scan_status === 'failed') && s.source_id && (
                                        <button className="btnGhost" type="button"
                                                style={{ padding: '4px 10px', fontSize: 11 }}
                                                onClick={() => scan(s)} disabled={r.scanning || r.busy}>
                                          {r.scanning ? 'Scanning…' : 'Scan now'}
                                        </button>
                                      )}
                                      {canDismiss && (
                                        <button className="btnGhost" type="button"
                                                style={{ padding: '4px 10px', fontSize: 11 }}
                                                onClick={() => decide(s, 'dismiss')} disabled={r.busy || r.scanning}>
                                          Dismiss
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}

          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 14, flexWrap: 'wrap' }}>
            <button className="btnGhost" type="button" onClick={findMore} disabled={running}>
              {running ? 'Searching… (up to 4 minutes)' : 'Find more now'}
            </button>
            {runNote && <span style={{ fontSize: 12.5, color: 'var(--text-soft)' }}>{runNote}</span>}
          </div>

          <div style={{ marginTop: 16, fontSize: 12.5 }}>
            <div style={{ color: 'var(--text-faint)' }}>
              Drum &amp; bass and house searches rotate through the countries you have sources in
              {sourceCountries.length ? ` (${sourceCountries.length})` : ''}, plus these:
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
              {extraCountries.length === 0 && (
                <span style={{ color: 'var(--text-faint)' }}>none added</span>
              )}
              {extraCountries.map((c) => (
                <span key={c} className="chip">
                  {c}{' '}
                  <button type="button" className="linkBtn" aria-label={`Remove ${c}`}
                          onClick={() => removeCountry(c)}>×</button>
                </span>
              ))}
            </div>
            <form onSubmit={addCountry} style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
              <input id="ss-country" name="country" placeholder="Add a country, e.g. Netherlands"
                     maxLength={80} style={{ maxWidth: 260 }} />
              <button className="btnGhost" type="submit" disabled={savingCountry}>
                {savingCountry ? 'Adding…' : 'Add country'}
              </button>
              {countryError && <span style={{ color: 'var(--danger)' }}>{countryError}</span>}
            </form>
          </div>
        </>
      )}
    </div>
  );
}
