-- AN "OTHER" CATEGORY FOR THE MARKET.
--
-- Not every good independent business fits the list. "Other" sits last, so
-- applicants who don't see themselves can still apply without forcing a fit.

insert into market_categories (name, slug, sort_order) values
  ('Other', 'other', 1000)
on conflict (slug) do nothing;
