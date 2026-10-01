'use client';

// ANNOUNCE TO FOLLOWERS — the structured mobile-first flow:
// event → update type → optional note (280, plain text) → aggregate
// audience preview → send now / schedule. Never a member list.

import { useState } from 'react';
import { useRouter } from 'next/navigation';

const UPDATE_TYPES: [string, string][] = [
  ['new_event', 'New event'],
  ['lineup_update', 'Lineup update'],
  ['tickets_on_sale', 'Tickets on sale'],
  ['final_tickets', 'Final tickets'],
  ['sold_out', 'Sold out'],
  ['date_change', 'Date change'],
  ['venue_change', 'Venue change'],
  ['event_cancelled', 'Event cancelled'],
  ['event_update', 'Other event update'],
];

const AUDIENCES: [string, string][] = [
  ['all', 'All followers'],
  ['near_event', 'Followers near the event'],
  ['genre_match', 'Followers who like matching genres'],
  ['city', 'Followers in a selected city'],
];

type Preview = { followers: number; targeted: number; email_eligible: number; inapp_eligible: number };

export function AnnounceForm({
  promoterId, events, cities, maxPer7Days,
}: {
  promoterId: string;
  events: { id: string; title: string; start_at: string; city: string | null; listing_status: string }[];
  cities: { id: string; name: string }[];
  maxPer7Days: number;
}) {
  const router = useRouter();
  const [eventId, setEventId] = useState('');
  const [updateType, setUpdateType] = useState('new_event');
  const [note, setNote] = useState('');
  const [audience, setAudience] = useState('all');
  const [locationId, setLocationId] = useState('');
  const [scheduleFor, setScheduleFor] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function call(body: Record<string, unknown>) {
    const res = await fetch(`/api/promoter/${promoterId}/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? 'Something went wrong');
    return data;
  }

  async function loadPreview() {
    if (!eventId) { setError('Pick an event first'); return; }
    setBusy(true);
    setError(null);
    try {
      const data = await call({ action: 'preview', eventId, audience, locationId: locationId || null });
      setPreview(data.preview);
    } catch (err) {
      setError((err as Error).message);
      setPreview(null);
    }
    setBusy(false);
  }

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const data = await call({
        action: 'create', eventId, updateType, note: note || null,
        audience, locationId: locationId || null,
        scheduleFor: scheduleFor ? new Date(scheduleFor).toISOString() : null,
      });
      setDone(data.status === 'scheduled' ? 'Scheduled ✓' : 'Sent to your followers ✓');
      setPreview(null);
      setNote('');
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  }

  const inputStyle = {
    background: 'var(--bg)', border: '1px solid var(--border-strong)', borderRadius: 8,
    color: 'var(--text)', padding: '10px 12px', width: '100%',
  } as const;

  return (
    <div className="youPanel announceSteps" data-draft="announce">
      <div>
        <h2 className="youPanelTitle" style={{ marginBottom: 4 }}>Announce to followers</h2>
        <p className="youPanelSub" style={{ margin: 0 }}>
          {`Structured updates about your events — Guestlist writes the message,
          delivers it by each member's own preferences, and never shares
          follower contact details. Up to ${maxPer7Days} announcements per 7 days.`}
        </p>
      </div>

      <label className="sectionLabel" style={{ margin: 0 }}>1 · Event</label>
      <select value={eventId} onChange={(e) => { setEventId(e.target.value); setPreview(null); }} style={inputStyle}>
        <option value="">Choose one of your events…</option>
        {events.map((e) => (
          <option key={e.id} value={e.id}>
            {`${e.title} — ${new Date(e.start_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${e.city ? ` · ${e.city}` : ''}`}
          </option>
        ))}
      </select>

      <label className="sectionLabel" style={{ margin: 0 }}>2 · What’s the update?</label>
      <div className="announceTypeGrid">
        {UPDATE_TYPES.map(([v, l]) => (
          <button key={v} type="button"
                  className={`btnGhost${updateType === v ? ' isActive' : ''}`}
                  onClick={() => setUpdateType(v)}>
            {l}
          </button>
        ))}
      </div>

      <label className="sectionLabel" style={{ margin: 0 }}>
        {`3 · Optional note (${280 - note.length} left — plain text, no links)`}
      </label>
      <textarea rows={3} maxLength={280} value={note} onChange={(e) => setNote(e.target.value)}
                placeholder="A short line in your own voice — the event details are added automatically."
                style={inputStyle} />

      <label className="sectionLabel" style={{ margin: 0 }}>4 · Audience</label>
      <select value={audience} onChange={(e) => { setAudience(e.target.value); setPreview(null); }} style={inputStyle}>
        {AUDIENCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
      </select>
      {audience === 'city' && (
        <select value={locationId} onChange={(e) => { setLocationId(e.target.value); setPreview(null); }} style={inputStyle}>
          <option value="">Choose a city…</option>
          {cities.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      )}

      <button className="btnGhost" type="button" disabled={busy || !eventId} onClick={loadPreview}>
        Preview audience
      </button>
      {preview && (
        <div className="followerStatGrid" style={{ margin: 0 }}>
          {([
            [preview.followers, 'Followers'],
            [preview.targeted, 'In this audience'],
            [preview.email_eligible, 'Eligible for email'],
            [preview.inapp_eligible, 'Eligible in-app'],
          ] as [number, string][]).map(([v, l]) => (
            <div className="announceStat" key={l}>
              <strong>{v.toLocaleString()}</strong>
              <span>{l}</span>
            </div>
          ))}
        </div>
      )}

      <label className="sectionLabel" style={{ margin: 0 }}>5 · Send</label>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btnAccent" type="button" disabled={busy || !eventId || !preview}
                title={preview ? '' : 'Preview the audience first'}
                onClick={send}>
          {scheduleFor ? 'Schedule' : 'Send now'}
        </button>
        <input type="datetime-local" value={scheduleFor} onChange={(e) => setScheduleFor(e.target.value)}
               style={{ ...inputStyle, width: 'auto' }} />
        {scheduleFor && (
          <button className="btnGhost" type="button" onClick={() => setScheduleFor('')}>Clear schedule</button>
        )}
      </div>
      {error && <div className="formError">{error}</div>}
      {done && <div className="youHistoryMeta">{done}</div>}
    </div>
  );
}

type HistoryItem = {
  id: string; update_type: string; audience: string; status: string;
  created_at: string; sent_at: string | null; event_title: string; note: string | null;
  delivered_inapp: number; delivered_email: number; emails_sent: number;
  attributed_views: number; attributed_ticket_clicks: number;
  going_since: number; interested_since: number; unsubscribes: number;
  preview: Record<string, number> | Record<string, never>;
};

export function AnnouncementHistory({ promoterId, items }: { promoterId: string; items: HistoryItem[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function cancel(id: string) {
    setBusy(true);
    await fetch(`/api/promoter/${promoterId}/announcements`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cancel', announcementId: id }),
    }).catch(() => {});
    setBusy(false);
    router.refresh();
  }

  if (items.length === 0) return null;
  return (
    <div className="youPanel" style={{ marginTop: 18 }}>
      <h2 className="youPanelTitle">Announcement history</h2>
      {items.map((a) => (
        <div className="adminRow" key={a.id} style={{ display: 'grid', gap: 4 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <strong>{a.event_title}</strong>
            <span className={`statePill${a.status === 'sent' ? ' active' : ''}`}>{a.status}</span>
            <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>
              {a.update_type.replace(/_/g, ' ')} · {a.audience.replace(/_/g, ' ')} ·{' '}
              {new Date(a.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
            </span>
            {['scheduled', 'queued'].includes(a.status) && (
              <button className="recHide" type="button" disabled={busy} onClick={() => cancel(a.id)}>
                cancel
              </button>
            )}
          </div>
          {a.note && <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>“{a.note}”</div>}
          {a.status === 'sent' && (
            <div className="youHistoryMeta">
              {`Delivered ${a.delivered_inapp} in-app · ${a.emails_sent} emails · FROM THIS ANNOUNCEMENT: ${a.attributed_views} event views, ${a.attributed_ticket_clicks} ticket clicks · since sent: +${a.interested_since} interested, +${a.going_since} going · ${a.unsubscribes} unsubscribed`}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
