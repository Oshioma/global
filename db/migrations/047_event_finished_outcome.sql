-- An imported page whose event has already happened is recorded as
-- 'event_finished' and dropped, instead of becoming an event in Needs Review
-- that nobody can go to (see lib/supply/pipeline.ts). Unpublished events that
-- finish while waiting for review are deleted by purgeFinishedUnpublished in
-- lib/adminEvents.ts, on every Publish all and every scheduled scan.

alter table extractions drop constraint if exists extractions_status_check;
alter table extractions add constraint extractions_status_check check (status in (
  'processing', 'succeeded', 'duplicate_linked',
  'invalid_url', 'unsafe_url', 'fetch_failed', 'not_found',
  'blocked_by_site', 'too_large', 'unsupported_content',
  'not_an_event', 'not_relevant', 'insufficient_information',
  'ai_extraction_failed', 'invalid_date', 'possible_duplicate', 'failed',
  'event_finished'
));
