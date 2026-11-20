import { query } from './db';
import { getMetaWhatsAppConfig } from './settings';

/**
 * What the CRM can honestly say about its database and WhatsApp, for the status pills. WhatsApp is not
 * called on every page load; its state comes from the configuration and recent sends:
 *   NOT_CONFIGURED  no Meta token or phone number id: sends are only simulated, nobody receives them
 *   FAILING         sends failed in the last hour and none succeeded
 *   OK              configured, and not failing as above
 *   UNKNOWN         could not be checked (e.g. the database is unreachable)
 * Never returns any credential.
 */

/** Recent sends considered for FAILING. */
const RECENT_MINUTES = 60;
/** At most this many of the newest outbound messages are read (by id, which needs no time index). */
const RECENT_ROWS = 1000;

export type WhatsAppState = 'OK' | 'FAILING' | 'NOT_CONFIGURED' | 'UNKNOWN';

export interface SystemStatus {
  database: { ok: boolean };
  whatsapp: {
    state: WhatsAppState;
    lastSentAt: string | null;
    failedLastHour: number;
    sentLastHour: number;
    /** More messages than RECENT_ROWS were sent in the last hour, so the counts are a lower bound. */
    countsCapped: boolean;
  };
  checkedAt: string;
}

/** FAILING only when every send in the window failed: one bad number among good sends is not an outage. */
export function whatsappState(configured: boolean, sentLastHour: number, failedLastHour: number): WhatsAppState {
  if (!configured) return 'NOT_CONFIGURED';
  return failedLastHour > 0 && sentLastHour === 0 ? 'FAILING' : 'OK';
}

export async function getSystemStatus(): Promise<SystemStatus> {
  const status: SystemStatus = {
    database: { ok: false },
    whatsapp: { state: 'UNKNOWN', lastSentAt: null, failedLastHour: 0, sentLastHour: 0, countsCapped: false },
    checkedAt: new Date().toISOString(),
  };
  try {
    await query('SELECT 1');
    status.database.ok = true;
  } catch (err: any) {
    console.error('[Status] Database check failed:', err?.message);
    return status;
  }

  try {
    const config = await getMetaWhatsAppConfig();
    if (!String(config?.access_token ?? '').trim() || !String(config?.phone_number_id ?? '').trim()) {
      status.whatsapp.state = whatsappState(false, 0, 0);
      return status;
    }
    const recent = (await query(
      `SELECT COUNT(*) FILTER (WHERE status = 'SENT')::int AS sent, COUNT(*) FILTER (WHERE status = 'FAILED')::int AS failed,
              COUNT(*)::int AS considered
       FROM (SELECT status, created_at FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' ORDER BY id DESC LIMIT $1) t
       WHERE created_at > CURRENT_TIMESTAMP - make_interval(mins => $2)`,
      [RECENT_ROWS, RECENT_MINUTES]
    )).rows[0];
    const last = (await query(
      `SELECT created_at FROM crm_whatsapp_logs WHERE direction = 'OUTBOUND' AND status = 'SENT' ORDER BY id DESC LIMIT 1`
    )).rows[0];
    status.whatsapp.sentLastHour = recent.sent;
    status.whatsapp.failedLastHour = recent.failed;
    status.whatsapp.countsCapped = recent.considered >= RECENT_ROWS;
    status.whatsapp.lastSentAt = last?.created_at ? new Date(last.created_at).toISOString() : null;
    status.whatsapp.state = whatsappState(true, recent.sent, recent.failed);
  } catch (err: any) {
    console.error('[Status] WhatsApp check failed:', err?.message);
  }
  return status;
}
