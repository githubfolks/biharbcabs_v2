import fs from 'fs';
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

export interface BackupStatus {
  state: 'OK' | 'STALE' | 'NOT_CONFIGURED';
  lastBackupAt: string | null;
  sizeBytes: number | null;
  encrypted: boolean | null;
}

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
  backup: BackupStatus;
  checkedAt: string;
}

const BACKUP_STALE_HOURS = 36;

function readBackupStatus(): BackupStatus {
  const statusFile = (process.env.CRM_BACKUP_STATUS_FILE || '').trim();
  if (!statusFile) return { state: 'NOT_CONFIGURED', lastBackupAt: null, sizeBytes: null, encrypted: null };
  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    const parsed = JSON.parse(raw);
    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : null;
    const ms = ts ? Date.parse(ts) : NaN;
    if (!ts || Number.isNaN(ms)) {
      return { state: 'STALE', lastBackupAt: null, sizeBytes: null, encrypted: null };
    }
    const ageHours = (Date.now() - ms) / (1000 * 60 * 60);
    return {
      state: ageHours <= BACKUP_STALE_HOURS ? 'OK' : 'STALE',
      lastBackupAt: ts,
      sizeBytes: typeof parsed.size_bytes === 'number' ? parsed.size_bytes : null,
      encrypted: typeof parsed.encrypted === 'boolean' ? parsed.encrypted : null,
    };
  } catch {
    return { state: 'STALE', lastBackupAt: null, sizeBytes: null, encrypted: null };
  }
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
    backup: readBackupStatus(),
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
