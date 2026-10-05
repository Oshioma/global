// The short list of extra countries the monthly suggestions search, on top of
// every country we already have a source in.

import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import { query } from '@/lib/db';
import { cleanCountry } from '@/lib/util';

export async function POST(req: NextRequest) {
  try {
    const admin = await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const country = cleanCountry(body.country);
    if (!country) return NextResponse.json({ error: 'Enter a country' }, { status: 400 });
    await query(
      `insert into source_suggestion_countries (country, added_by) values ($1, $2)
       on conflict (country) do nothing`,
      [country, admin.id]
    );
    return NextResponse.json({ ok: true, country });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const country = cleanCountry(body.country);
    if (!country) return NextResponse.json({ error: 'Enter a country' }, { status: 400 });
    await query(`delete from source_suggestion_countries where country = $1`, [country]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
