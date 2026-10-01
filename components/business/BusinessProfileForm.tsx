'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { ImageField } from '@/components/market/ImageField';

type Values = {
  name: string; tagline: string; description: string; categoryId: string; city: string; country: string; address: string;
  website: string; logoUrl: string; heroImageUrl: string; contactName: string; contactEmail: string; socials: Record<string, string>;
};

const SOCIALS = ['instagram', 'tiktok', 'facebook', 'x'] as const;

export function BusinessProfileForm({ businessId, initial, categories, endpoint, extra }: {
  businessId: string; initial: Values; categories: { id: string; name: string }[];
  // The portal PATCHes its own endpoint; the admin desk posts through the market desk.
  endpoint: 'portal' | 'admin';
  extra?: React.ReactNode;
}) {
  const router = useRouter();
  const [v, setV] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const upd = (patch: Partial<Values>) => setV((x) => ({ ...x, ...patch }));

  // FIND IMAGES (and a save that read the website) writes pictures straight
  // to the listing, then refreshes the page. The form keeps its own copy of
  // the fields, so pull in anything the server found for a field that is
  // still blank — without touching edits in progress, and without ever
  // handing a stale blank back on the next save (which would clear them).
  const [seen, setSeen] = useState({ logo: initial.logoUrl, hero: initial.heroImageUrl });
  if (seen.logo !== initial.logoUrl || seen.hero !== initial.heroImageUrl) {
    setSeen({ logo: initial.logoUrl, hero: initial.heroImageUrl });
    setV((x) => ({ ...x, logoUrl: x.logoUrl || initial.logoUrl, heroImageUrl: x.heroImageUrl || initial.heroImageUrl }));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(''); setMsg('');
    const res = endpoint === 'portal'
      ? await fetch(`/api/business/${businessId}/profile`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(v) })
      : await fetch('/api/admin/market', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'update', businessId, business: v }) });
    setBusy(false);
    const j = await res.json().catch(() => ({}));
    if (res.ok) { setMsg(j.identityChangeFlagged ? 'Saved. A name or website change is flagged for Guestlist to check.' : 'Saved.'); router.refresh(); }
    else setErr(j.error ?? 'Save failed');
  }

  return (
    <form className="formCard" style={{ maxWidth: 640, margin: '10px 0 60px' }} onSubmit={submit}>
      <label htmlFor="b-name">Business name</label>
      <input id="b-name" value={v.name} onChange={(e) => upd({ name: e.target.value })} required />
      <label htmlFor="b-tag">One line</label>
      <input id="b-tag" value={v.tagline} onChange={(e) => upd({ tagline: e.target.value })} placeholder="Independent record shop in Peckham since 2011" />
      <label htmlFor="b-cat">Category</label>
      <select id="b-cat" value={v.categoryId} onChange={(e) => upd({ categoryId: e.target.value })}>
        <option value="">Choose…</option>
        {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
      </select>
      <label htmlFor="b-desc">About</label>
      <textarea id="b-desc" rows={5} value={v.description} onChange={(e) => upd({ description: e.target.value })} />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label htmlFor="b-city">City</label><input id="b-city" value={v.city} onChange={(e) => upd({ city: e.target.value })} /></div>
        <div><label htmlFor="b-country">Country</label><input id="b-country" value={v.country} onChange={(e) => upd({ country: e.target.value })} /></div>
      </div>
      <label htmlFor="b-addr">Address</label>
      <input id="b-addr" value={v.address} onChange={(e) => upd({ address: e.target.value })} />
      <label htmlFor="b-web">Website</label>
      <input id="b-web" value={v.website} onChange={(e) => upd({ website: e.target.value })} placeholder="https://…" />
      <ImageField id="b-logo" label="Logo" value={v.logoUrl}
                  onChange={(url) => upd({ logoUrl: url })} placeholder="https://… or upload (square)" />
      {v.logoUrl && <ImagePreview key={v.logoUrl} src={v.logoUrl} kind="logo" onClear={() => upd({ logoUrl: '' })} />}
      <ImageField id="b-hero" label="Photo" value={v.heroImageUrl}
                  onChange={(url) => upd({ heroImageUrl: url })} placeholder="https://… or upload (landscape)" />
      {v.heroImageUrl && <ImagePreview key={v.heroImageUrl} src={v.heroImageUrl} kind="photo" onClear={() => upd({ heroImageUrl: '' })} />}
      <p className="fieldNote">Paste a link or upload a picture — JPEG, PNG, WebP or GIF.</p>
      {SOCIALS.map((k) => (
        <div key={k}>
          <label htmlFor={`b-${k}`} style={{ textTransform: 'capitalize' }}>{k}</label>
          <input id={`b-${k}`} value={v.socials[k] ?? ''} onChange={(e) => upd({ socials: { ...v.socials, [k]: e.target.value } })} placeholder="https://…" />
        </div>
      ))}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14 }}>
        <div><label htmlFor="b-cn">Contact name</label><input id="b-cn" value={v.contactName} onChange={(e) => upd({ contactName: e.target.value })} /></div>
        <div><label htmlFor="b-ce">Contact email</label><input id="b-ce" value={v.contactEmail} onChange={(e) => upd({ contactEmail: e.target.value })} /></div>
      </div>
      {extra}
      <div className="formError">{err}</div>
      {msg && <div className="formOk">{msg}</div>}
      <button className="btnAccent" style={{ width: '100%', marginTop: 8 }} disabled={busy} type="submit">{busy ? 'Saving…' : 'Save listing'}</button>
    </form>
  );
}

// What the link actually shows, so nobody has to save and go looking.
function ImagePreview({ src, kind, onClear }: { src: string; kind: 'logo' | 'photo'; onClear: () => void }) {
  // Keyed on src by the caller, so a new link starts unbroken.
  const [broken, setBroken] = useState(false);
  return (
    <div className="imagePreview" data-kind={kind}>
      {broken
        ? <span className="fieldNote" style={{ margin: 0 }}>That link doesn’t load as an image.</span>
        /* eslint-disable-next-line @next/next/no-img-element */
        : <img src={src} alt="" className={kind === 'logo' ? 'imagePreviewLogo' : 'imagePreviewPhoto'} onError={() => setBroken(true)} />}
      <button type="button" className="btnGhost" style={{ padding: '4px 10px', fontSize: 10.5 }} onClick={onClear}>Remove</button>
    </div>
  );
}
