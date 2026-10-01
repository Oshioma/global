'use client';

// GET ME IN — on the event page. Built for a phone: one big button, a
// JUST ME / ME +1 toggle, an optional line to us, and then one of four
// friendly states. Never a paragraph of terms.

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { track } from '@/lib/track';

export type FriendlyView = { key: 'working' | 'guestlisted' | 'discount' | 'answered' | 'sorry' | 'cancelled'; title: string; body: string };
export type RequestView = { id: string; places: number; friendly: FriendlyView; member_price_pence: number | null; currency: string } | null;

export function GetMeIn({
  eventId, viewer, initialRequest, billingLive, price,
}: {
  eventId: string;
  viewer: 'anon' | 'nonmember' | 'member';
  initialRequest: RequestView;
  billingLive: boolean;
  price: string;
}) {
  const [request, setRequest] = useState<RequestView>(initialRequest);
  const [places, setPlaces] = useState<1 | 2>(1);
  const [note, setNote] = useState('');
  const [showNote, setShowNote] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { track('get_me_in_viewed', { eventId, viewer }); }, [eventId, viewer]);

  async function go() {
    setBusy(true); setError('');
    try {
      const r = await fetch(`/api/events/${eventId}/get-me-in`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ places, note }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'Could not send your request');
      setRequest(j.request);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send your request');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (!request) return;
    setBusy(true);
    const r = await fetch(`/api/membership/requests/${request.id}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'cancel' }),
    });
    setBusy(false);
    if (r.ok) setRequest(null);
  }

  if (viewer !== 'member') {
    return (
      <div className="getMeIn" data-draft="get-me-in">
        <div className="getMeInKicker">Guestlist membership</div>
        <div className="getMeInTitle">Get in free</div>
        <p className="getMeInSub">Member? Ask Guestlist to get you in free. Members get free entrance to parties whenever we can make it happen — plus discounts, priority access and special offers.</p>
        <Link href="/membership" className="getMeInBtn" style={{ textDecoration: 'none' }}>
          {billingLive ? `Join — ${price}/month` : 'Membership coming soon'}
        </Link>
        {viewer === 'anon' && <p className="getMeInQualifier"><Link href={`/login?next=${encodeURIComponent(`/events`)}`} style={{ textDecoration: 'underline' }}>Already a member? Sign in</Link></p>}
        <p className="getMeInQualifier">Subject to availability and fair use.</p>
      </div>
    );
  }

  if (request) {
    const f = request.friendly;
    return (
      <div className="getMeIn">
        <div className="getMeInKicker">Get me in</div>
        <div className={`reqState ${f.key}`}>
          <p className="t">{f.title}</p>
          <p className="b">{f.body}</p>
          {request.places > 1 && f.key !== 'cancelled' && <p className="b" style={{ marginTop: 6 }}>For you +1.</p>}
        </div>
        {(f.key === 'working' || f.key === 'guestlisted') && (
          <button className="getMeInLink" onClick={cancel} disabled={busy}>{f.key === 'guestlisted' ? 'Can’t make it? Give up your place' : 'Cancel this request'}</button>
        )}
        {f.key === 'cancelled' || f.key === 'sorry' ? (
          <button className="getMeInLink" onClick={() => setRequest(null)}>Ask again</button>
        ) : null}
        <p className="getMeInQualifier"><Link href="/you/membership" style={{ textDecoration: 'underline' }}>All your events →</Link></p>
      </div>
    );
  }

  return (
    <div className="getMeIn">
      <div className="getMeInKicker">Guestlist member</div>
      <div className="getMeInTitle">Get me in</div>
      <p className="getMeInSub">Ask Guestlist to get you in free. We’ll go to the promoter, the venue or our own list and come back to you.</p>
      <div className="placesToggle" role="group" aria-label="How many places">
        <button type="button" className={places === 1 ? 'active' : ''} onClick={() => setPlaces(1)}>Just me</button>
        <button type="button" className={places === 2 ? 'active' : ''} onClick={() => setPlaces(2)}>Me +1</button>
      </div>
      {showNote ? (
        <input className="getMeInNote" value={note} onChange={(e) => setNote(e.target.value.slice(0, 500))}
               placeholder="Anything we should know? (optional)" />
      ) : null}
      <button className="getMeInBtn" onClick={go} disabled={busy}>{busy ? 'Sending…' : 'Get me in'}</button>
      {!showNote && <button className="getMeInLink" onClick={() => setShowNote(true)}>Add a note</button>}
      {error && <p className="getMeInQualifier" style={{ color: 'var(--danger)' }}>{error}</p>}
      <p className="getMeInQualifier">Subject to availability and fair use. +1s when we can.</p>
    </div>
  );
}
