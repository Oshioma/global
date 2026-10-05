'use client';

// FIND SOURCES: search a country (optionally one city) for clubs, promoters,
// festivals and calendars that programme the genres we care about, test each
// one against the real scanner, and add the ones that work.
//
// Suggestions come from a model, so nothing here is taken on trust: a
// candidate cannot be added until it has been fetched and we have seen what
// the scanner would find on it. A suggestion that does not resolve just
// fails its test and stays out.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { GenrePicker, type GenreOpt } from '@/components/admin/GenrePicker';
import { probeLabel, testVerdict, type ProbeResult } from '@/lib/supply/verdict';
import { matchGenreIdsByName, sourceTypeLabel } from '@/lib/util';
import { explainScan, type OutcomeTally } from '@/lib/supply/outcomes';
import { startAndWatchScan } from '@/lib/supply/watchScan';

type Candidate = {
  name: string;
  url: string;
  homepage: string | null;
  kind: string;
  city: string | null;
  country: string;
  genres: string[];
  note: string | null;
  known: boolean;
};

type ScanSummary = {
  status: string; extracted: number; candidatesFound: number;
  newCandidates: number; duplicates: number; failed: number; error: string | null;
  couldPoll: boolean; outcomes: OutcomeTally;
};

type RowState = {
  testing: boolean;
  result: ProbeResult | null;
  adding: boolean;
  addedId: string | null;
  scanning: boolean;
  scan: ScanSummary | null;
  error: string;
};

const blankRow = (): RowState => ({
  testing: false, result: null, adding: false, addedId: null,
  scanning: false, scan: null, error: '',
});

export function SourceDiscovery({
  genres, countries,
}: {
  genres: GenreOpt[];
  countries: string[];
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [country, setCountry] = useState('');
  const [city, setCity] = useState('');
  // Everything on by default: the usual search is "what is on in this country
  // at all", and narrowing is the deliberate act, not widening.
  const [genreIds, setGenreIds] = useState<string[]>(genres.map((g) => g.id));
  const allSelected = genreIds.length === genres.length;
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [testingAll, setTestingAll] = useState(false);

  const setRow = (url: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [url]: { ...(prev[url] ?? blankRow()), ...patch } }));

  async function search() {
    if (!country.trim()) { setError('Choose a country first'); return; }
    setSearching(true);
    setError('');
    setCandidates([]);
    setRows({});
    try {
      const res = await fetch('/api/admin/sources/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ country, city: city || null, genreIds, limit: 10 }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setCandidates(data.candidates ?? []);
        setSearched(true);
      } else {
        setError(data?.error ?? 'Search failed');
      }
    } catch {
      setError('Could not reach the server — try again');
    } finally {
      setSearching(false);
    }
  }

  async function test(url: string): Promise<ProbeResult | null> {
    setRow(url, { testing: true, error: '', result: null });
    try {
      const res = await fetch('/api/admin/sources/test-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) { setRow(url, { testing: false, result: data }); return data as ProbeResult; }
      setRow(url, { testing: false, error: data?.error ?? 'Test failed' });
    } catch {
      setRow(url, { testing: false, error: 'Could not reach the server' });
    }
    return null;
  }

  // Sequential on purpose — testing ten sites at once is a small burst of
  // traffic at other people's servers, and the per-fetch delay is the whole
  // politeness contract of the scanner.
  async function testAll() {
    setTestingAll(true);
    for (const c of candidates) {
      if (c.known || rows[c.url]?.result) continue;
      await test(c.url);
    }
    setTestingAll(false);
  }

  // What the source gets TAGGED with is not the search filter. When the whole
  // taxonomy is selected, tagging a club with thirty genres would say nothing;
  // so prefer the genres the candidate itself was described with, and fall
  // back to the search selection only when it was a deliberate narrowing.
  function tagsFor(c: Candidate): string[] {
    const own = matchGenreIdsByName(c.genres, genres);
    if (own.length) return own;
    return allSelected ? [] : genreIds;
  }

  async function add(c: Candidate) {
    setRow(c.url, { adding: true, error: '' });
    try {
      // If the test had to find the real listing page, add THAT — adding the
      // dead URL we started from would guarantee a source that finds nothing.
      const url = rows[c.url]?.result?.target ?? c.url;
      const res = await fetch('/api/admin/sources', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: c.name,
          url,
          sourceType: c.kind,
          city: c.city,
          country: c.country,
          genreIds: tagsFor(c),
          notes: c.note,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setRow(c.url, { adding: false, addedId: data.id ?? 'added' });
        router.refresh();
      } else {
        setRow(c.url, { adding: false, error: data?.error ?? 'Could not add' });
      }
    } catch {
      setRow(c.url, { adding: false, error: 'Could not reach the server' });
    }
  }

  // Adding a source is not the finish line — scanning it is. Doing it here
  // means you see how many of those candidate links actually become events
  // without leaving the search.
  async function scan(c: Candidate, id: string) {
    setRow(c.url, { scanning: true, error: '', scan: null });
    // The POST only starts the scan; wait for the row to say how it finished.
    const out = await startAndWatchScan(id);
    if (out.ok) setRow(c.url, { scanning: false, scan: out.scan });
    else setRow(c.url, { scanning: false, error: out.error });
    router.refresh();
  }

  return (
    <div className="discoverPanel">
      <div className="discoverHead">
        <div>
          <strong>Find clubs &amp; events</strong>
          <div style={{ color: 'var(--text-faint)', fontSize: 12.5 }}>
            Search a country for venues, promoters and festivals playing your genres,
            test each one against the scanner, then add the ones that work.
          </div>
        </div>
        <button className="btnGhost" type="button" onClick={() => setOpen((o) => !o)}>
          {open ? 'Close' : 'Search by country'}
        </button>
      </div>

      {open && (
        <>
          <div className="discoverForm">
            <div>
              <label htmlFor="d-country">Country *</label>
              <input id="d-country" value={country} onChange={(e) => setCountry(e.target.value)}
                     placeholder="e.g. Tanzania" maxLength={80} list="d-countries" />
              <datalist id="d-countries">
                {countries.map((c) => <option key={c} value={c} />)}
              </datalist>
            </div>
            <div>
              <label htmlFor="d-city">City (optional)</label>
              <input id="d-city" value={city} onChange={(e) => setCity(e.target.value)}
                     placeholder="e.g. Dar es Salaam" maxLength={80} />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginTop: 10 }}>
            <label style={{ margin: 0 }}>Genres</label>
            <button
              type="button"
              className="linkBtn"
              onClick={() => setGenreIds(allSelected ? [] : genres.map((g) => g.id))}
            >
              {allSelected ? 'Clear all' : 'Select all'}
            </button>
          </div>
          <GenrePicker genres={genres} selected={genreIds} onChange={setGenreIds} wrap />
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginTop: 10, flexWrap: 'wrap' }}>
            <button className="btnAccent" type="button" onClick={search} disabled={searching}>
              {searching ? 'Searching…' : 'Find sources'}
            </button>
            {candidates.length > 0 && (
              <button className="btnGhost" type="button" onClick={testAll} disabled={testingAll}>
                {testingAll ? 'Testing…' : 'Test all'}
              </button>
            )}
            {error && <span style={{ color: 'var(--danger)', fontSize: 12.5 }}>{error}</span>}
          </div>

          {searched && candidates.length === 0 && !error && (
            <p style={{ color: 'var(--text-faint)', fontSize: 13, marginTop: 12 }}>
              Nothing found for that country and genre mix — try the country on its own,
              or fewer genres.
            </p>
          )}

          {candidates.length > 0 && (
            <div className="adminTableWrap" style={{ marginTop: 14 }}>
              <table className="adminTable">
                <thead>
                  <tr>
                    <th>Candidate</th>
                    <th>Where</th>
                    <th>Type</th>
                    <th>Test result</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {candidates.map((c) => {
                    const row = rows[c.url] ?? blankRow();
                    const v = row.result ? testVerdict(row.result) : null;
                    return (
                      <tr key={c.url}>
                        <td>
                          <strong>{c.name}</strong>
                          <div style={{ fontSize: 11.5 }}>
                            <a href={c.url} target="_blank" rel="noopener noreferrer"
                               style={{ textDecoration: 'underline', wordBreak: 'break-all' }}>
                              {c.url}
                            </a>
                          </div>
                          {c.note && (
                            <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{c.note}</div>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {c.city ?? '—'}
                          <div style={{ color: 'var(--text-faint)', fontSize: 11.5 }}>{c.country}</div>
                        </td>
                        <td style={{ fontSize: 12 }}>{sourceTypeLabel(c.kind)}</td>
                        <td style={{ minWidth: 220 }}>
                          {c.known ? (
                            <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>
                              Already a source
                            </span>
                          ) : row.testing ? (
                            <span style={{ fontSize: 12 }}>Testing…</span>
                          ) : v && row.result ? (
                            <div style={{ fontSize: 11.5, lineHeight: 1.5,
                                          color: v.bad ? 'var(--danger)' : 'var(--text-soft)' }}>
                              {v.text}
                              <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>
                                bot: {probeLabel(row.result.bot)} · browser: {probeLabel(row.result.browser)}
                              </div>
                            </div>
                          ) : (
                            <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Not tested</span>
                          )}
                          {row.scan && (
                            <div style={{ fontSize: 11.5, lineHeight: 1.5, marginTop: 4,
                                          color: row.scan.extracted > 0 ? 'var(--text-soft)' : 'var(--danger)' }}>
                              {row.scan.status === 'succeeded' ? (
                                <>
                                  Scanned: {row.scan.candidatesFound} candidate
                                  {row.scan.candidatesFound === 1 ? '' : 's'} · {row.scan.extracted} extracted ·{' '}
                                  {row.scan.duplicates} duplicate · {row.scan.failed} failed
                                  {row.scan.extracted > 0 ? (
                                    <>
                                      {/* An offer, not a fait accompli: scanning
                                          records what happened, it does not put a
                                          source on the schedule. */}
                                      {row.scan.couldPoll && <> · <b>not polling yet</b></>}
                                      {' — '}
                                      <a href="/admin/events?state=new" style={{ textDecoration: 'underline' }}>review →</a>
                                    </>
                                  ) : (
                                    <> — nothing readable on those pages yet, so it stays off the schedule</>
                                  )}
                                  {/* "0 extracted" is a count, not a reason. The
                                      pipeline knows why each page failed, so say it. */}
                                  {explainScan(row.scan.outcomes, row.scan.extracted) && (
                                    <div style={{ marginTop: 3 }}>
                                      {explainScan(row.scan.outcomes, row.scan.extracted)}
                                    </div>
                                  )}
                                </>
                              ) : (row.scan.error ?? 'Scan failed')}
                            </div>
                          )}
                          {row.error && (
                            <div style={{ color: 'var(--danger)', fontSize: 11.5 }}>{row.error}</div>
                          )}
                        </td>
                        <td style={{ whiteSpace: 'nowrap' }}>
                          {c.known ? (
                            <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>—</span>
                          ) : row.addedId ? (
                            // Added, but not yet proven: scanning is what turns
                            // a source into events, so offer it right here.
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                              <span style={{ color: 'var(--text-faint)', fontSize: 12 }}>Added ✓</span>
                              {row.addedId !== 'added' && (
                                <button className="btnGhost" type="button"
                                        style={{ padding: '4px 10px', fontSize: 11 }}
                                        onClick={() => scan(c, row.addedId!)} disabled={row.scanning}>
                                  {row.scanning ? 'Scanning…' : row.scan ? 'Scan again' : 'Scan now'}
                                </button>
                              )}
                            </div>
                          ) : (
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button className="btnGhost" type="button"
                                      style={{ padding: '4px 10px', fontSize: 11 }}
                                      onClick={() => test(c.url)} disabled={row.testing || testingAll}>
                                {row.result ? 'Retest' : 'Test'}
                              </button>
                              {/* Add stays shut until we have fetched the page
                                  ourselves: an untested suggestion is just a
                                  sentence from a model. */}
                              <button
                                className={v && !v.bad ? 'btnAccent' : 'btnGhost'}
                                type="button"
                                style={{ padding: '4px 10px', fontSize: 11 }}
                                onClick={() => add(c)}
                                disabled={!row.result || row.adding}
                                title={row.result ? undefined : 'Test it first'}
                              >
                                {row.adding ? 'Adding…' : v?.bad ? 'Add anyway' : 'Add source'}
                              </button>
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
        </>
      )}
    </div>
  );
}
