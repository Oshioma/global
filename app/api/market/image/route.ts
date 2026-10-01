// A picture off a business's own machine — their logo or a photo of the
// place — for the Market application and the business portal's listing.
//
// Signed-in members only (the same people who can apply). Same storage and
// the same sniffing as the event and site pictures: the bytes are checked to
// actually be an image, the path is generated, and the media limit applies.

import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireMember } from '@/lib/auth';
import { MediaError, storeSiteImage } from '@/lib/archive/media';

export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    await requireMember();
    if (!(req.headers.get('content-type') ?? '').includes('multipart/form-data')) {
      return NextResponse.json({ error: 'Attach a picture' }, { status: 400 });
    }
    const form = await req.formData();
    const file = form.get('file');
    if (!(file instanceof File)) return NextResponse.json({ error: 'No picture attached' }, { status: 400 });
    const stored = await storeSiteImage(Buffer.from(await file.arrayBuffer()));
    return NextResponse.json({ url: stored.url, bytes: stored.bytes });
  } catch (err) {
    if (err instanceof AuthError) return NextResponse.json({ error: err.message }, { status: err.status });
    if (err instanceof MediaError) return NextResponse.json({ error: err.message }, { status: err.status });
    console.error(err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
