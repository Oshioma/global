# Deploying Guestlist to production

Guestlist is a Next.js app backed by PostgreSQL. You need three things:
a Postgres database, a Node host (Vercel is the easiest), and a handful of
environment variables. ~30 minutes end to end.

## 1. Create the database

Use Supabase (or Neon, RDS — any Postgres 14+).

- **Supabase**: create a project, then grab two connection strings from
  *Project Settings → Database*:
  - **Direct connection** (port 5432) — used once, to run migrations.
  - **Transaction pooler** (port 6543) — used by the deployed app.
- If a connection fails with an SSL error, append `?sslmode=require`.

## 2. Apply the schema

**Option A (recommended)** — from your own machine, in the repo:

```bash
DATABASE_URL="postgres://...direct-connection...:5432/postgres" npm run db:migrate
```

This applies `db/migrations/001–003` in order and records them in
`_migrations`, so future deploys just re-run the same command for new
migrations.

**Option B** — paste the contents of `db/migrations/001_events_platform.sql`,
`002_event_supply_engine.sql`, `003_promoter_network.sql` (in that order)
into the SQL editor, then record them:

```sql
create table if not exists _migrations (
  name text primary key, applied_at timestamptz not null default now()
);
insert into _migrations (name) values
  ('001_events_platform.sql'),
  ('002_event_supply_engine.sql'),
  ('003_promoter_network.sql')
on conflict (name) do nothing;
```

## 3. Seed production data

Run `db/production_setup.sql` in the SQL editor. It inserts the real genre
taxonomy (12 parents + 16 subgenres), idempotently.

**Do NOT run `npm run db:seed` against production** — the dev seed is
fictional test data and it truncates tables.

## 4. Deploy the app (Vercel)

1. vercel.com → *Add New Project* → import the `Oshioma/global` GitHub repo.
   Framework auto-detects as Next.js; no build settings needed.
2. Set environment variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | the **pooler** connection string (port 6543) |
| `SESSION_SECRET` | a long random string — `openssl rand -hex 32` |
| `ANTHROPIC_API_KEY` | *(optional but recommended)* an Anthropic API key from console.anthropic.com — enables AI extraction; without it, imports run structured-data-only and everything lands in admin review |
| `CRON_SECRET` | another `openssl rand -hex 32` — **required for the scheduled jobs.** Supabase sends it as a bearer token (step 7); the job endpoints reject unauthenticated calls |
| `SUPPLY_CRON_SECRET` | *(optional)* the same idea, for an external scheduler you drive yourself |

   Never set `SUPPLY_FETCH_ALLOW_HOSTS` in production (dev/test only).
3. Deploy, and check the preview URL loads `/events`.

### Switching on Guestlist Membership payments (Stripe)

`/membership` is live from the first deploy — without Stripe it reads
COMING SOON and collects a waitlist, which you can see on `/admin/members`.
To take money:

1. In Stripe, create a product **Guestlist Membership** with a recurring
   price of **£30 / month**. Copy the price id (`price_…`).
2. Developers → Webhooks → add endpoint
   `https://www.guestlist.net/api/webhooks/stripe` listening to
   `checkout.session.completed`, `customer.subscription.created`,
   `customer.subscription.updated`, `customer.subscription.deleted`,
   `invoice.paid`, `invoice.payment_failed`. Copy the signing secret.
3. Settings → Billing → Customer portal: enable it, allow customers to
   cancel subscriptions and update payment methods.
4. Add to Vercel: `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`,
   `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MEMBERSHIP_MONTHLY`, and `SITE_URL`
   (the absolute URL Stripe redirects back to). Redeploy.
5. Optionally mirror the price id into the database so it survives an env
   change: `update membership_plans set stripe_price_id = 'price_…' where code = 'member_monthly';`
6. Test with a Stripe test card, then check `/admin/members` shows the
   member as *Active · stripe* and `/you/membership` opens the Billing
   Portal.

**If the webhook is wrong,** paid members still get in: the welcome page
Stripe sends them to carries the Checkout session id, asks Stripe whether it
paid, and activates the membership through the same code the webhook uses.
`/admin/systems` → Stripe → *Webhook traffic* tells you whether real events
are arriving; fix the endpoint anyway, because renewals, cancellations and
failed payments only reach the site through it.

**Telling the waitlist.** Once Stripe is on, ADMIN → Members → *Tell the
waitlist (N)* emails everyone still waiting that membership is open, once
each; anyone who has joined since is skipped and drops off the list. Run
migration `039_waitlist_invite.sql` first (it adds `invited_at`).

**Cancelling or refunding a paying member** is done from ADMIN → Members,
on the member's row: *Cancel* (at the end of the paid month, or now) and
*Refund* (blank for the whole last payment, or an amount). Both go through
Stripe, both are written to the billing ledger with who and why, and the
member is emailed. Refunds never exceed what is left of the last payment.
`npm run verify:refund` exercises the whole path against a stand-in Stripe.

**Managed Payments.** Newer Stripe accounts have *Managed Payments* (Stripe
as merchant of record, collecting tax for you) switched on by default, and
it refuses any product without a tax code — JOIN then fails with *"the
product tax code is missing"*. Guestlist turns it off on every Checkout it
opens, so nothing to do. If you decide you *do* want Stripe as merchant of
record, set `STRIPE_MANAGED_PAYMENTS=true` and give the product a tax code
in Stripe → Product catalogue; `/admin/systems` tells you if it is missing.

Membership pages, GET ME IN, the Market and the admin desks work with or
without Stripe; only the JOIN button depends on it.

## 5. Point the domain

In Vercel → project → *Domains*, add `guestlist.net` (and `www`), then
update your DNS as Vercel instructs (A record `76.76.21.21` for the apex,
CNAME `cname.vercel-dns.com` for www). This replaces the old static-site
hosting entirely — the landing page now lives at `/` inside the app.

## 6. Create your admin account

1. Visit `https://www.guestlist.net/signup` and register normally.
2. In the SQL editor:

```sql
update members set role = 'admin' where lower(email) = lower('you@guestlist.net');
```

3. Reload the site — an **Admin** link appears in the header.

## 7. Schedule the background jobs (Supabase)

Scheduling lives in **Supabase**, not Vercel: Vercel's Hobby plan only runs a
cron once a day, and these jobs want to run hourly. Supabase drives them with
`pg_cron` + `pg_net`, which also means the schedule is visible and editable in
the same place as the data.

In Supabase → *Database* → *Extensions*, enable **pg_cron** and **pg_net**.
Then, in the SQL editor (once — replace the secret with the value of
`CRON_SECRET`, and the domain with your own):

```sql
-- The bearer token lives in Vault, not in the job definition, so it is not
-- readable from cron.job by anyone who can read the schedule. Written as a
-- block that can be re-run: vault.create_secret fails on a name that already
-- exists, which is a confusing error to meet the second time round.
do $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = 'guestlist_cron_secret';
  if v_id is null then
    perform vault.create_secret(
      'PASTE_THE_CRON_SECRET_HERE', 'guestlist_cron_secret',
      'Bearer token for Guestlist job endpoints');
  else
    perform vault.update_secret(v_id, 'PASTE_THE_CRON_SECRET_HERE');
  end if;
end $$;

select cron.schedule('guestlist-scan-sources', '0 */6 * * *', $job$
  select net.http_post(
    url := 'https://www.guestlist.net/api/jobs/scan-sources',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'guestlist_cron_secret'
      )
    ),
    body := '{}'::jsonb
  );
$job$);

select cron.schedule('guestlist-send-emails', '0 * * * *', $job$
  select net.http_post(
    url := 'https://www.guestlist.net/api/jobs/send-emails',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'guestlist_cron_secret'
      )
    ),
    body := '{}'::jsonb
  );
$job$);

-- Monthly source suggestions (5 drum & bass, 5 house, 5 hip hop) for
-- /admin/sources. Runs at 07:12 UTC on days 1–7: the first run usually fills
-- the month, and the rest only top up what a short run missed — once all
-- fifteen are in they return straight away without calling the AI. The admin
-- email goes out when the batch is full, or on day 7 with whatever was found.
select cron.schedule('guestlist-suggest-sources', '12 7 1-7 * *', $job$
  select net.http_post(
    url := 'https://www.guestlist.net/api/jobs/suggest-sources',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (
        select decrypted_secret from vault.decrypted_secrets where name = 'guestlist_cron_secret'
      )
    ),
    body := '{}'::jsonb
  );
$job$);
```

Keep the token in Vault as above rather than writing it into the job body.
A token pasted straight into `cron.schedule` sits in plaintext in `cron.job`,
readable by anyone with database access and easy to copy out by accident.

To check it is running:

```sql
select jobname, schedule, active from cron.job;
select j.jobname, r.status, r.start_time, r.return_message
  from cron.job_run_details r join cron.job j on j.jobid = r.jobid
 order by r.start_time desc limit 20;
```

That tells you the schedule fired — but not what the website said back.
`net.http_post` hands the request off and returns a row id immediately, so a
job that fired at a dead domain with a wrong token still reads `succeeded`
here. The reply lands somewhere else, and this is the query that matters:

```sql
select id, status_code, error_msg, created
  from net._http_response
 order by created desc limit 20;
```

`200` is the job actually running. A `401` means the token does not match
`CRON_SECRET` (or `SUPPLY_CRON_SECRET`) in the Vercel environment. A `timeout`
in `error_msg` is usually not a failure: `pg_net` gives up listening after five
seconds by default while `/api/jobs/send-emails` is allowed five minutes, so
the job is still running on Vercel long after Postgres stops waiting for it.
Nothing depends on the answer coming back, so that is harmless — pass
`timeout_milliseconds := 30000` to `net.http_post` if you would rather see the
status code than guess. To see what token is stored:
`select name, decrypted_secret from vault.decrypted_secrets where name = 'guestlist_cron_secret';` To change a schedule, call
`cron.schedule` again with the same job name; `select cron.unschedule('guestlist-scan-sources');`
removes one.

Both endpoints accept GET and POST, so any external scheduler (cron-job.org,
a GitHub Actions schedule, a server crontab) works too:

```
*/30 * * * *  curl -s -X POST https://www.guestlist.net/api/jobs/scan-sources \
                -H "Authorization: Bearer $SUPPLY_CRON_SECRET"
```

A source is only scanned on that schedule once it is polling, and a source
starts polling when its first scan actually brings back an event. Add it,
**Scan now**, and it puts itself on the schedule.

## 8. Smoke test

- `/events` — empty state renders with "Add an event" prompt (no events yet).
- `/admin/events` (as admin) — queues render.
- `/admin/sources` → **+ Add Source** → add a promoter events page →
  **Scan now** → review what lands in ADMIN → EVENTS → NEW.
- Publish one event; confirm it appears on `/events` and GET TICKETS
  redirects (and logs a `ticket_clicked` row in `analytics_events`).
- `/promoters` — promoters appear once events/promoters exist.

## 9. First real-world extraction validation

From any machine with normal internet access:

```bash
ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/manual-extract.ts --scan https://somepromoter.com/events
```

It fetches respectfully (one listing fetch, max two event extractions,
delays between requests) and prints per-field extraction results. Run it
against ~15–20 independent promoter/venue/festival sites; the admin
**Supply** log records structured-data hit rates, AI token usage, and
failure states for every extraction.

## Ongoing

- New migrations: `DATABASE_URL=... npm run db:migrate` (direct connection).
- Local dev: `cp .env.example .env.local`, `npm install`, `npm run db:reset`,
  `npm run dev` — dev accounts all use password `guestlist`.
- Test suites: `npm run verify` (81), `npm run test:supply` (161),
  `npm run verify:v2b` (124) — all against a local dev server + database.
