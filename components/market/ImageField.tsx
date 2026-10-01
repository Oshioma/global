'use client';

// A picture for a Market business: paste a link, or upload one from the
// computer or phone. Uploads go to /api/market/image and come back as a URL,
// so the rest of the form only ever deals in links.

import { useState } from 'react';

// Vercel rejects request bodies over ~4.5MB, so phone photos are shrunk in
// the browser first.
const UPLOAD_LIMIT = 4 * 1024 * 1024;

async function shrinkImage(file: File): Promise<File> {
  if (file.size <= UPLOAD_LIMIT) return file;
  if (!/^image\/(jpeg|png|webp)$/.test(file.type)) return file; // gif: recompressing loses animation
  try {
    const bitmap = await createImageBitmap(file);
    const maxDim = 2200;
    const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob: Blob | null = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.85));
    if (blob && blob.size < file.size) {
      return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
    }
  } catch {
    /* fall through — the size check still guards the upload */
  }
  return file;
}

export function ImageField({ id, label, value, onChange, placeholder }: {
  id: string;
  label: string;
  value: string;
  onChange: (url: string) => void;
  placeholder?: string;
}) {
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');

  async function upload(file: File) {
    setUploading(true);
    setError('');
    try {
      const small = await shrinkImage(file);
      if (small.size > UPLOAD_LIMIT) throw new Error('That image is too large (about 4MB max) — try a smaller one');
      const body = new FormData();
      body.append('file', small);
      const res = await fetch('/api/market/image', { method: 'POST', body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ?? 'Could not upload that');
      onChange(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not upload that');
    } finally {
      setUploading(false);
    }
  }

  return (
    <>
      <label htmlFor={id}>{label}</label>
      <div className="evImgRow">
        <input id={id} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
        {/* A label wrapping a hidden input, because a bare file input cannot be
            styled to look like the rest of this form in any browser. */}
        <label className="btnGhost evImgUpload" style={{ margin: 0 }}>
          {uploading ? 'Uploading…' : 'Upload'}
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            hidden
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              // Clear it either way, so choosing the same file twice still fires.
              e.target.value = '';
              if (file) upload(file);
            }}
          />
        </label>
      </div>
      {error && <div className="formError">{error}</div>}
    </>
  );
}
