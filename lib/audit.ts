import { query } from './db';

export type AuditAction =
  | 'profile_changed' | 'event_created' | 'event_edited' | 'event_cancelled'
  | 'event_rescheduled' | 'event_sold_out' | 'event_restored' | 'event_confirmed'
  | 'event_ignored' | 'event_reported' | 'event_claimed' | 'event_claim_decided'
  | 'event_deleted' | 'events_bulk_published' | 'events_finished_purged' | 'source_deleted'
  | 'source_connected' | 'source_paused' | 'source_resumed' | 'source_url_changed'
  | 'source_trust_changed'
  | 'source_scanned' | 'team_member_added' | 'team_member_removed' | 'role_changed'
  | 'team_invited' | 'claim_submitted' | 'claim_approved' | 'claim_rejected'
  | 'claim_info_requested' | 'promoter_suspended' | 'promoter_unsuspended'
  | 'room_message_removed' | 'member_club_suspended' | 'member_club_unsuspended'
  // Membership
  | 'access_request_created' | 'access_request_updated' | 'access_request_note'
  | 'access_request_linked' | 'access_request_imported' | 'access_request_promoter_assigned'
  | 'promoter_contact_added' | 'promoter_outreach_logged' | 'promoter_relationship_changed'
  | 'membership_changed'
  // Market
  | 'market_business_created' | 'market_business_updated' | 'market_business_decided'
  | 'market_offer_created' | 'market_offer_updated' | 'market_offer_decided'
  | 'market_offer_redeemed' | 'member_drop_changed' | 'good_cause_changed'
  | 'member_deleted' | 'article_deleted' | 'member_verified' | 'site_image_changed'
  // Balance
  | 'retreat_changed' | 'retreat_deleted';

export async function audit(
  action: AuditAction,
  opts: {
    actorId?: string | null;
    promoterId?: string | null;
    eventId?: string | null;
    sourceId?: string | null;
    detail?: Record<string, unknown>;
  } = {}
): Promise<void> {
  try {
    await query(
      `insert into audit_log (actor_member_id, promoter_id, event_id, source_id, action, detail)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        opts.actorId ?? null, opts.promoterId ?? null, opts.eventId ?? null,
        opts.sourceId ?? null, action, JSON.stringify(opts.detail ?? {}),
      ]
    );
  } catch (err) {
    console.error('audit log failed', err);
  }
}

export async function notifyPromoter(
  promoterId: string,
  type: string,
  opts: { eventId?: string | null; sourceId?: string | null; payload?: Record<string, unknown> } = {}
): Promise<void> {
  try {
    await query(
      `insert into promoter_notifications (promoter_id, type, event_id, source_id, payload)
       values ($1, $2, $3, $4, $5)`,
      [promoterId, type, opts.eventId ?? null, opts.sourceId ?? null, JSON.stringify(opts.payload ?? {})]
    );
  } catch (err) {
    console.error('notification insert failed', err);
  }
}
