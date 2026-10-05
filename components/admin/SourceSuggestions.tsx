'use client';

// THIS MONTH'S SUGGESTIONS: five drum & bass, five house and five hip hop
// promoters or clubs a month, found and tested by the monthly job
// (/api/jobs/suggest-sources). Every one has already passed the scanner test;
// none is a source until an admin presses Add.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { sourceTypeLabel } from '@/lib/util';

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
};

const BUCKETS = [
  { key: 'dnb', label: 'Drum & Bass' },
  { key: 'house', label: 'House' },
  { key: 'hiphop', label: 'Hip Hop' },
];

type RowState = { busy: boolean; error: string; scanning: boolean; scanNote: string };
const blank = (): RowState => ({ busy: false, error: '', scanning: false, scanNote: '' });

export function SourceSuggestions({
  month, suggestions, extraCountries, sourceCountries,
}: {
  month: string;
  suggestions: SuggestionRow[];
  extraCountries: string[];
  sourceCountries: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(suggestions.some((s) => s.status === 'pending'));
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [running, setRunning] = useState(false);
  const [runNote, setRunNote] = useState('');
  const [countryError, setCountryError] = useState('');
  const [savingCountry, setSavingCountry] = useState(false);

  const setRow = (id: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? blank()), ...patch } }));

  const pending = suggestions.filter((s) => s.status === 'pending').length;
  const thisMonth = suggestions.filter((s) => s.batch_month === month);

  async function decide(s: SuggestionRow, action: 'add' | 'dismiss') {
    setRow(s.id, { busy: true, error: '' });
    try {
      const res = await fetch(`/api/admin/sources/suggestions/${s.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRow(s.id, { busy: false });
        router.refresh();
      } else {
        setRow(s.id, { busy: false, error: data?.error ?? 'Could not save' });
      }
    } catch {
      setRow(s.id, { busy: false, error: 'Could not reach the server' });
    }
  }

  // Adding is not the finish line — scanning is. Same offer as the search.
  async function scan(s: SuggestionRow) {
    if (!s.source_id) return;
    setRow(s.id, { scanning: true, error: '', scanNote: '' });
    try {
      const res = await fetch(`/api/admin/sources/${s.source_id}/scan`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRow(s.id, {
          scanning: false,
          scanNote: data.status === 'succeeded'
            ? `Scanned: ${data.extracted ?? 0} extracted, ${data.duplicates ?? 0} duplicate, ${data.failed ?? 0} failed`
            : (data.error ?? 'Scan failed'),
        });
        router.refresh();
      } else {
        setRow(s.id, { scanning: false, error: data?.error ?? 'Scan failed' });
      }
    } catch {
      setRow(s.id, { scanning: false, error: 'Could not reach the server' });
    }
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
        setRunNote(
          added
            ? `Found ${added} more.${data.outOfTime ? ' Ran out of time — press again to carry on.' : ''}`
            : errors.length
              ? `Nothing new — ${errors[0]}`
              : data.outOfTime
                ? 'Ran out of time before finding any — press again to carry on.'
                : 'Nothing new this time: every genre is full for the month, or no country had a site that passed the test.'
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

  return (
    <div className="discoverPanel" id="suggestions">
      <div className="discoverHead">
        <div>
          <strong>This month&rsquo;s suggestions{pending > 0 ? ` (${pending} to review)` : ''}</strong>
          <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
            Every month: 5 drum &amp; bass, 5 house and 5 hip hop promoters or clubs that aren&rsquo;t
            sources yet, rotating through your countries. Each one has already passed the scanner
            test — nothing is added until you press Add.
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
                          return (
                            <tr key={s.id} style={s.status === 'dismissed' ? { opacity: 0.5 } : undefined}>
                              <td>
                                <strong>{s.name}</strong>
                                <div style={{ fontSize: 11.5 }}>
                                  <a href={s.url} target="_blank" rel="noopener noreferrer"
                                     style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>
                                    {s.url}
                                  </a>
                                </div>
                                {s.note && (
                                  <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{s.note}</div>
                                )}
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                {s.city ?? '—'}
                                <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{s.country}</div>
                              </td>
                              <td style={{ fontSize: 12 }}>{sourceTypeLabel(s.kind)}</td>
                              <td style={{ fontSize: 11.5, minWidth: 200, color: 'var(--text-soft)' }}>
                                {s.verdict ?? `${s.candidates ?? 0} event links found`}
                                {r.scanNote && <div style={{ marginTop: 4 }}>{r.scanNote}</div>}
                                {r.error && <div style={{ color: 'var(--danger)' }}>{r.error}</div>}
                              </td>
                              <td style={{ whiteSpace: 'nowrap' }}>
                                {s.status === 'pending' ? (
                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                                    <button className="btnAccent" type="button"
                                            style={{ padding: '4px 10px', fontSize: 11 }}
                                            onClick={() => decide(s, 'add')} disabled={r.busy}>
                                      {r.busy ? 'Saving…' : 'Add source'}
                                    </button>
                                    <button className="btnGhost" type="button"
                                            style={{ padding: '4px 10px', fontSize: 11 }}
                                            onClick={() => decide(s, 'dismiss')} disabled={r.busy}>
                                      Dismiss
                                    </button>
                                  </div>
                                ) : s.status === 'added' ? (
                                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                                    <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Added ✓</span>
                                    {s.source_id && (
                                      <button className="btnGhost" type="button"
                                              style={{ padding: '4px 10px', fontSize: 11 }}
                                              onClick={() => scan(s)} disabled={r.scanning}>
                                        {r.scanning ? 'Scanning…' : 'Scan now'}
                                      </button>
                                    )}
                                  </div>
                                ) : (
                                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Dismissed</span>
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
              Searches rotate through the countries you have sources in
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
