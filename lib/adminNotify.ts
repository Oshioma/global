// TELLING THE ADMINS.
//
// Everyone else on Guestlist gets told when something happens to them. The
// people running it got nothing: a member joined, an article was submitted,
// fifty events landed from an overnight scan, and the only way to find out
// was to open each queue and look.
//
// The shape matters more than the plumbing here. Two rules:
//
// 1. One notification per happening ONLY where the happening is rare. A new
//    member and a submitted article each deserve their own line. A new event
//    does not — one scan can bring in fifty, and fifty bells is a bell nobody
//    reads again.
// 2. Everything that needs a decision is ONE rolling digest per admin, kept
//    current rather than repeated. Reading it clears it; the next change
//    raises a fresh one. The bell means "there is work", not "here is a
//    history of the work count changing".
//
// Nothing in here is allowed to break the thing that triggered it. Somebody
// signing up must not fail because a notification could not be written, so
// every entry point swallows its own errors and says so in the log.

import { query, queryOne } from './db';
import { heldForSuggestionSql } from './adminEvents';

export type ReviewQueue = {
  events: number;
  articles: number;
  claims: number;
  corrections: number;
  reports: number;
  genreSuggestions: number;
  accessRequests: number;
  marketApplications: number;
  total: number;
};

const admins = () =>
  query<{ id: string }>(`select id from members where role = 'admin'`);

// A count that fails (a table this deployment does not have yet) is a zero,
// never a broken admin page.
async function count(sql: string): Promise<number> {
  try {
    const row = await queryOne<{ n: number }>(sql);
    return row?.n ?? 0;
  } catch {
    return 0;
  }
}

// Everything waiting on a person. This is the one definition — the digest,
// the admin dashboard panel and the tests all read it, so they cannot drift.
export async function reviewQueue(): Promise<ReviewQueue> {
  const [events, articles, claims, corrections, reports, genreSuggestions, accessRequests, marketApplications] = await Promise.all([
    // Events waiting under an undecided source suggestion are decided on
    // /admin/sources, not in the queue, so they are not counted here.
    count(`select count(*)::int as n from events e
            where e.status in ('new', 'needs_review')
              and coalesce(e.end_at, e.start_at + interval '6 hours') > now()
              and not ${heldForSuggestionSql('e')}`),
    count(`select count(*)::int as n from articles where status = 'submitted'`),
    count(`select count(*)::int as n from promoter_claims where status = 'pending'`),
    count(`select count(*)::int as n from archive_corrections where status = 'open'`),
    // Anything a member has reported: another member, or a memory in the
    // archive. Both land on a person, so both belong in the same count.
    count(`select ((select count(*) from member_reports where status = 'open')
                 + (select count(*) from archive_memories
                     where status = 'visible' and report_count > 0))::int as n`),
    count(`select count(*)::int as n from genre_suggestions where status = 'pending'`),
    // GET ME IN requests the desk still has to broker — a request the
    // promoter's own list is already handling is not waiting on us.
    count(`select count(*)::int as n from member_access_requests r
            left join event_guestlist_entries g on g.id = r.guestlist_entry_id
            where r.status in ('requested', 'reviewing', 'contacting_promoter')
              and (g.id is null or g.status = 'declined')`),
    count(`select count(*)::int as n from market_businesses where status in ('applied', 'pending')`),
  ]);
  return {
    events, articles, claims, corrections, reports, genreSuggestions, accessRequests, marketApplications,
    total: events + articles + claims + corrections + reports + genreSuggestions + accessRequests + marketApplications,
  };
}

// The digest, in words. Kept here so the notification centre and the admin
// panel say the same thing.
export function reviewQueueSummary(q: ReviewQueue): string {
  const parts = [
    q.events && `${q.events} event${q.events === 1 ? '' : 's'}`,
    q.articles && `${q.articles} article${q.articles === 1 ? '' : 's'}`,
    q.claims && `${q.claims} promoter claim${q.claims === 1 ? '' : 's'}`,
    q.corrections && `${q.corrections} correction${q.corrections === 1 ? '' : 's'}`,
    q.reports && `${q.reports} report${q.reports === 1 ? '' : 's'}`,
    q.genreSuggestions && `${q.genreSuggestions} genre suggestion${q.genreSuggestions === 1 ? '' : 's'}`,
    q.accessRequests && `${q.accessRequests} GET ME IN request${q.accessRequests === 1 ? '' : 's'}`,
    q.marketApplications && `${q.marketApplications} Market application${q.marketApplications === 1 ? '' : 's'}`,
  ].filter(Boolean) as string[];
  if (!parts.length) return 'Nothing waiting for review.';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  return `${list} waiting for review`;
}

// Refresh the rolling digest. Idempotent by design: the partial unique index
// allows one unread digest per admin, so this updates the existing row rather
// than stacking another one. Safe to call as often as anything changes.
export async function refreshAdminReviewDigest(): Promise<number> {
  try {
    const q = await reviewQueue();
    const people = await admins();
    if (q.total === 0) {
      // The work is done — clear the standing digest rather than leave a
      // bell pointing at an empty queue.
      await query(
        `delete from notifications where type = 'admin_review_waiting' and read_at is null`
      );
      return 0;
    }
    for (const admin of people) {
      const updated = await query(
        `update notifications set payload = $2, created_at = now()
          where member_id = $1 and type = 'admin_review_waiting' and read_at is null
          returning id`,
        [admin.id, q]
      );
      if (!updated.length) {
        await query(
          `insert into notifications (member_id, type, payload)
           values ($1, 'admin_review_waiting', $2)
           on conflict do nothing`,
          [admin.id, q]
        );
      }
    }
    return people.length;
  } catch (err) {
    console.error('admin review digest failed', err);
    return 0;
  }
}

export async function notifyAdminsNewMember(memberId: string): Promise<number> {
  try {
    const member = await queryOne<{ display_name: string; slug: string | null; home_city: string | null }>(
      `select display_name, slug, home_city from members where id = $1`, [memberId]
    );
    if (!member) return 0;
    const people = (await admins()).filter((a) => a.id !== memberId);
    for (const admin of people) {
      await query(
        `insert into notifications (member_id, type, actor_member_id, payload)
         values ($1, 'admin_new_member', $2, $3)
         on conflict do nothing`,
        [admin.id, memberId, { name: member.display_name, slug: member.slug, city: member.home_city }]
      );
    }
    return people.length;
  } catch (err) {
    console.error('new member notification failed', err);
    return 0;
  }
}

export async function notifyAdminsNewArticle(articleId: string): Promise<number> {
  try {
    const article = await queryOne<{ title: string; author_name: string }>(
      `select a.title, m.display_name as author_name
         from articles a join members m on m.id = a.author_id where a.id = $1`,
      [articleId]
    );
    if (!article) return 0;
    const people = await admins();
    for (const admin of people) {
      await query(
        `insert into notifications (member_id, type, article_id, payload)
         values ($1, 'admin_new_article', $2, $3)
         on conflict do nothing`,
        [admin.id, articleId, { title: article.title, author: article.author_name }]
      );
    }
    await refreshAdminReviewDigest();
    return people.length;
  } catch (err) {
    console.error('new article notification failed', err);
    return 0;
  }
}

// An author edited something the desk has already seen — published, approved,
// or sitting in review. Not a queue item (nothing is blocked on it) and not
// silent either: one unread line per article, refreshed rather than repeated,
// so five typo fixes in a row are one notification.
export async function notifyAdminsArticleEdited(articleId: string): Promise<number> {
  try {
    const article = await queryOne<{ title: string; author_name: string; slug: string; status: string }>(
      `select a.title, a.slug, a.status, m.display_name as author_name
         from articles a join members m on m.id = a.author_id where a.id = $1`,
      [articleId]
    );
    if (!article) return 0;
    const people = await admins();
    for (const admin of people) {
      const payload = { title: article.title, author: article.author_name, slug: article.slug, status: article.status };
      const updated = await query(
        `update notifications set payload = $3, created_at = now()
          where member_id = $1 and article_id = $2 and type = 'admin_article_edited' and read_at is null
          returning id`,
        [admin.id, articleId, payload]
      );
      if (!updated.length) {
        await query(
          `insert into notifications (member_id, type, article_id, payload)
           values ($1, 'admin_article_edited', $2, $3)
           on conflict do nothing`,
          [admin.id, articleId, payload]
        );
      }
    }
    return people.length;
  } catch (err) {
    console.error('article edited notification failed', err);
    return 0;
  }
}
