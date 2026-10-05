// ADD or DISMISS one monthly source suggestion. Adding creates the source the
// same way the Add source form does — polling off, until its first scan
// produces an event — and tags it with the suggestion's genres where they
// match our taxonomy.

import { NextRequest, NextResponse } from 'next/server';
import { AuthError, requireAdmin } from '@/lib/auth';
import { query, queryOne } from '@/lib/db';
import { bucketGenres, type GenreKey } from '@/lib/supply/suggest';
import { matchGenreIdsByName } from '@/lib/util';

type Suggestion = {
  id: string; genre_key: GenreKey; name: string; url: string; kind: string;
  city: string | null; country: string | null; genres: string[]; note: string | null;
  status: string;
};

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const admin = await requireAdmin();
    const { id } = await params;
    const body = await req.json().catch(() => ({}));
    const action = body.action === 'dismiss' ? 'dismiss' : body.action === 'add' ? 'add' : null;
    if (!action) return NextResponse.json({ error: 'Unknown action' }, { status: 400 });

    const s = await queryOne<Suggestion>(
      `select id, genre_key, name, url, kind, city, country, genres, note, status
         from source_suggestions where id = $1`,
      [id]
    );
    if (!s) return NextResponse.json({ error: 'Suggestion not found' }, { status: 404 });
    if (s.status !== 'pending') {
      return NextResponse.json({ error: `Already ${s.status}` }, { status: 409 });
    }

    if (action === 'dismiss') {
      await query(
        `update source_suggestions set status = 'dismissed', decided_at = now(), decided_by = $2
          where id = $1`,
        [id, admin.id]
      );
      return NextResponse.json({ ok: true });
    }

    const dup = await queryOne<{ id: string }>(`select id from event_sources where url = $1`, [s.url]);
    let sourceId = dup?.id ?? null;
    if (!sourceId) {
      const created = await queryOne<{ id: string }>(
        `insert into event_sources (source_type, name, url, notes, city, country)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [s.kind, s.name, s.url, s.note, s.city, s.country]
      );
      sourceId = created!.id;
      const genres = await query<{ id: string; name: string }>(
        `select id, name from genres where active`
      );
      let genreIds = matchGenreIdsByName(s.genres, genres);
      if (!genreIds.length) genreIds = bucketGenres(s.genre_key, genres).map((g) => g.id).slice(0, 1);
      if (genreIds.length) {
        await query(
          `insert into event_source_genres (source_id, genre_id)
           select $1, g.id from genres g where g.id = any($2::uuid[])
           on conflict do nothing`,
          [sourceId, genreIds]
        );
      }
    }
    await query(
      `update source_suggestions
          set status = 'added', source_id = $2, decided_at = now(), decided_by = $3
        where id = $1`,
      [id, sourceId, admin.id]
    );
    return NextResponse.json({ ok: true, sourceId, existed: !!dup });
  } catch (err) {
    if (err instanceof AuthError) {
      return NextResponse.json({ error: err.message }, { status: err.status });
    }
    console.error(err);
    return NextResponse.json({ error: 'Something went wrong' }, { status: 500 });
  }
}
