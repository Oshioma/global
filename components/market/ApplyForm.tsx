'use client';

// A business asking to be in Guestlist Market. It is an application, not a
// listing: Guestlist decides who is in.

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageField } from './ImageField';

export function ApplyForm({ categories }: { categories: { id: string; name: string }[] }) {
  const router = useRouter();
  const [v, setV] = useState({ name: '', tagline: '', description: '', categoryId: '', city: '', country: '', website: '', contactName: '', contactEmail: '', instagram: '', logoUrl: '', heroImageUrl: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upd = (patch: Partial<typeof v>) => setV((x) => ({ ...x, ...patch }));

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const r = await fetch('/api/market/apply', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...v, socials: { instagram: v.instagram } }),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setError(j.error || 'Could not send your application'); setBusy(false); return; }
    router.push('/business?applied=1');
  }

  return (
    <form className="formCard" style={{ maxWidth: 640, margin: '10px 0 80px' }} onSubmit={submit}>
      <label htmlFor="ap-name">Business name</label>
      <input id="ap-name" required value={v.name} onChange={(e) => upd({ name: e.target.value })} />
      <label htmlFor="ap-tag">One line about you</label>
      <input id="ap-tag" value={v.tagline} onChange={(e) => upd({ tagline: e.target.value })} placeholder="Independent record shop in Peckham since 2011" />
      <label htmlFor="ap-cat">Category</label>
      <select id="ap-cat" value={v.categoryId} onChange={(e) => upd({ categoryId: e.target.value })}>
        <option value="">Choose…</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label htmlFor="ap-city">City</label><input id="ap-city" value={v.city} onChange={(e) => upd({ city: e.target.value })} /></div>
        <div><label htmlFor="ap-country">Country</label><input id="ap-country" value={v.country} onChange={(e) => upd({ country: e.target.value })} /></div>
      </div>
      <label htmlFor="ap-web">Website</label>
      <input id="ap-web" value={v.website} onChange={(e) => upd({ website: e.target.value })} placeholder="https://…" />
      <label htmlFor="ap-ig">Instagram</label>
      <input id="ap-ig" value={v.instagram} onChange={(e) => upd({ instagram: e.target.value })} placeholder="https://instagram.com/…" />
      <ImageField id="ap-hero" label="A photo of the place or the product" value={v.heroImageUrl}
                  onChange={(url) => upd({ heroImageUrl: url })} placeholder="https://… or upload (landscape)" />
      {v.heroImageUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <div className="evImgPreview"><img src={v.heroImageUrl} alt="" /></div>
      )}
      <ImageField id="ap-logo" label="Your logo" value={v.logoUrl}
                  onChange={(url) => upd({ logoUrl: url })} placeholder="https://… or upload (square)" />
      {v.logoUrl && (
        // eslint-disable-next-line @next/next/no-img-element
        <div className="evImgPreview" style={{ width: 120 }}><img src={v.logoUrl} alt="" style={{ height: 120 }} /></div>
      )}
      <p className="fieldNote">Optional — a good photo gets you noticed. Leave them blank and we’ll take the picture your website shares.</p>
      <label htmlFor="ap-desc">Tell us about the business and what you’d like to offer Guestlist members</label>
      <textarea id="ap-desc" rows={5} value={v.description} onChange={(e) => upd({ description: e.target.value })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label htmlFor="ap-cn">Your name</label><input id="ap-cn" value={v.contactName} onChange={(e) => upd({ contactName: e.target.value })} /></div>
        <div><label htmlFor="ap-ce">Contact email</label><input id="ap-ce" type="email" value={v.contactEmail} onChange={(e) => upd({ contactEmail: e.target.value })} /></div>
      </div>
      <div className="formError">{error}</div>
      <button className="btnAccent" style={{ width: '100%', marginTop: 8 }} disabled={busy} type="submit">{busy ? 'Sending…' : 'Apply to join Guestlist Market'}</button>
      <p className="fieldNote" style={{ marginTop: 12 }}>Guestlist chooses who’s in the Market. We’ll come back to you by email.</p>
    </form>
  );
}
