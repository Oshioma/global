// POLL or DISMISS one monthly source suggestion.
//
// POLL puts the suggestion's source on the polling schedule and publishes the
// upcoming events it has already found (possible duplicates still wait for a
// person). DISMISS deletes the source and the unpublished events only it
// brought in; the suggestion is kept so the site is never suggested again.
// See lib/supply/suggest.ts.

import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import { dismissSuggestion, pollSuggestion } from '@/lib/supply/suggest';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    // 'add' is the old name for 'poll', kept for a page loaded before the
    // change.
    const action = body.action === 'dismiss' ? 'dismiss'
      : body.action === 'poll' || body.action === 'add' ? 'poll' : null;
    if (!action) return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    const out = action === 'poll'
      ? await pollSuggestion(id, admin.id)
      : await dismissSuggestion(id, admin.id);
    if (!out.ok) {
      const status = out.error === 'Suggestion not found' ? 404 : 409;
      return NextResponse.json({ error: out.error }, { status });
    }
    return NextResponse.json(out);
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
