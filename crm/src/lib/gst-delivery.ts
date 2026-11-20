import { query, withTransaction } from './db';
import { getCompanyBillingInfo, getSetting } from './settings';
import { stateCodeFromGstin } from './gst-states';
import { GstDocumentKind, gstDocumentPdf } from './gst-pdf';
import { notify, recordNotificationFailure } from './wa-notify';
import { sendWhatsAppDocument, uploadWhatsAppMedia } from './whatsapp';

/**
 * Sends each GST document to its customer on WhatsApp (per CA, Section 31 CGST Act), from the frequent
 * cron job. Inside the 24-hour window it goes as a document message, otherwise as the
 * customer_gst_document template with the PDF in its header. The PDF is uploaded to Meta and sent by
 * media id, so documents are never on a public URL.
 *
 * A document waits (no attempt used) while BiharCabs' GSTIN or its place of supply is missing. A send
 * that fails is retried on later runs; after gst_document_delivery.max_attempts it is marked FAILED and
 * recorded once under Failed messages, and finance can download and send it by hand. Documents issued
 * before migration 29 are NOT_SENT and never sent automatically.
 */

const BATCH = 50;
const DEFAULT_MAX_ATTEMPTS = 3;

/** Each kind: table, the condition for an issued document, and what the customer is told it is. Fixed SQL. */
const KINDS: Record<GstDocumentKind, { table: string; number: string; issued: string; label: string }> = {
  TI: { table: 'crm_invoices', number: 'invoice_number', issued: 'TRUE', label: 'tax invoice' },
  RV: { table: 'crm_payment_links', number: 'receipt_voucher_number', issued: "d.receipt_voucher_number IS NOT NULL AND d.purpose = 'ADVANCE'", label: 'receipt voucher' },
  RF: { table: 'crm_refunds', number: 'refund_voucher_number', issued: 'd.refund_voucher_number IS NOT NULL', label: 'refund voucher' },
  CC: { table: 'crm_cancellation_charges', number: 'invoice_number', issued: "d.status = 'ISSUED'", label: 'cancellation charge invoice' },
};
const ORDER: GstDocumentKind[] = ['RV', 'TI', 'CC', 'RF'];

export interface GstDeliveryResult {
  sent: number;
  failed: number;
  retrying: number;
  /** True when nothing was attempted because BiharCabs' GSTIN is not set. */
  waitingForGstin: boolean;
}

async function maxAttempts(): Promise<number> {
  const n = Number((await getSetting<any>('gst_document_delivery', {}))?.max_attempts);
  return Number.isInteger(n) && n >= 1 && n <= 20 ? n : DEFAULT_MAX_ATTEMPTS;
}

export async function sendPendingGstDocuments(): Promise<GstDeliveryResult> {
  const result: GstDeliveryResult = { sent: 0, failed: 0, retrying: 0, waitingForGstin: false };
  const company: any = await getCompanyBillingInfo();
  if (!stateCodeFromGstin(company?.gstin)) {
    result.waitingForGstin = true;
    return result;
  }
  const max = await maxAttempts();
  for (const kind of ORDER) {
    const k = KINDS[kind];
    const ids = (await query(
      `SELECT d.id FROM ${k.table} d
       WHERE d.wa_delivery_status = 'PENDING' AND d.place_of_supply_code IS NOT NULL AND ${k.issued}
       ORDER BY d.id LIMIT $1`,
      [BATCH]
    )).rows.map((r) => Number(r.id));
    for (const id of ids) {
      const outcome = await deliver(kind, id, max).catch((err) => {
        console.error(`[GST delivery] ${kind} #${id} not processed:`, err?.message);
        return null;
      });
      if (outcome) result[outcome]++;
    }
  }
  return result;
}

/**
 * Send one document. Its row is locked for the send, so two runs cannot send it twice. If the process
 * stops after WhatsApp accepted it but before the row is saved, the next run sends it again: a
 * duplicate copy, never a lost one.
 */
async function deliver(kind: GstDocumentKind, id: number, max: number): Promise<'sent' | 'failed' | 'retrying' | null> {
  const k = KINDS[kind];
  return withTransaction(async (client) => {
    const doc = (await client.query(
      `SELECT d.id, d.${k.number} AS number, d.wa_attempts, b.booking_code, c.phone
       FROM ${k.table} d JOIN crm_bookings b ON b.id = d.booking_id JOIN crm_customers c ON c.id = b.customer_id
       WHERE d.id = $1 AND d.wa_delivery_status = 'PENDING' AND d.place_of_supply_code IS NOT NULL AND ${k.issued}
       FOR UPDATE OF d SKIP LOCKED`,
      [id]
    )).rows[0];
    if (!doc) return null;

    const params = [k.label, doc.number, `#${doc.booking_code}`];
    let error: string | null = null;
    let channel: 'FREEFORM' | 'TEMPLATE' | null = null;
    if (!doc.phone) {
      error = 'Customer has no phone number';
    } else {
      const pdf = await gstDocumentPdf(kind, id).catch((err: any) => {
        error = `PDF not produced: ${err?.message || err}`;
        return null;
      });
      const upload = pdf ? await uploadWhatsAppMedia(pdf.buffer, pdf.fileName, 'application/pdf') : null;
      if (!pdf || !upload) {
        // error set above
      } else if (!upload.success || !upload.mediaId) {
        error = upload.error || 'Media upload failed';
      } else {
        const media = { mediaId: upload.mediaId, fileName: pdf.fileName };
        const sent = await notify(doc.phone, 'customer_gst_document', {
          params,
          headerDocument: media,
          freeform: () => sendWhatsAppDocument(doc.phone, media.mediaId, media.fileName, `Your BiharCabs ${k.label} ${doc.number} for booking #${doc.booking_code}.`),
          recordFailure: false,
        }).catch((err: any) => ({ success: false, error: err?.message || String(err), channel: null }));
        channel = (sent as any).channel ?? null;
        if (!sent.success) error = sent.error || 'Send failed';
      }
    }

    if (!error) {
      await client.query(
        `UPDATE ${k.table} SET wa_delivery_status = 'SENT', wa_sent_at = CURRENT_TIMESTAMP, wa_attempts = wa_attempts + 1, wa_last_error = NULL WHERE id = $1`,
        [id]
      );
      return 'sent';
    }
    const attempts = Number(doc.wa_attempts) + 1;
    const final = attempts >= max;
    await client.query(
      `UPDATE ${k.table} SET wa_attempts = $2, wa_last_error = $3, wa_delivery_status = CASE WHEN $4 THEN 'FAILED' ELSE 'PENDING' END WHERE id = $1`,
      [id, attempts, error.slice(0, 500), final]
    );
    if (final) {
      // Reported once, so staff send it by hand (Finance: download the PDF).
      await recordNotificationFailure(doc.phone || '-', 'customer_gst_document', params, channel, `${error} (after ${attempts} tries)`);
      return 'failed';
    }
    return 'retrying';
  });
}

export interface GstDocumentRow {
  kind: GstDocumentKind;
  id: number;
  number: string;
  date: string;
  bookingCode: string;
  amount: number;
  deliveryStatus: 'PENDING' | 'SENT' | 'FAILED' | 'NOT_SENT';
  sentAt: string | null;
  lastError: string | null;
  /** A PDF can be made once the place of supply is set (and BiharCabs' GSTIN, checked when downloading). */
  placeOfSupplySet: boolean;
}

/** Each kind's date and amount, for the Finance list. Fixed SQL. */
const LIST_SQL: Record<GstDocumentKind, { date: string; amount: string }> = {
  TI: { date: 'd.created_at', amount: 'd.total_amount' },
  RV: { date: 'd.paid_at', amount: 'd.amount_paise / 100.0' },
  RF: { date: 'd.refund_voucher_date', amount: 'd.amount_paise / 100.0' },
  CC: { date: 'd.invoice_date', amount: 'd.amount' },
};

/**
 * GST documents for the Finance page: those matching a booking code or document number, or, with no
 * search, those whose WhatsApp delivery FAILED (to send by hand). Newest first, at most 100.
 */
export async function listGstDocuments(search?: string): Promise<GstDocumentRow[]> {
  const q = String(search ?? '').trim().replace(/^#/, '').toUpperCase().slice(0, 40);
  const parts = (Object.keys(KINDS) as GstDocumentKind[]).map((kind) => {
    const k = KINDS[kind];
    const l = LIST_SQL[kind];
    const filter = q ? `(UPPER(b.booking_code) = $1 OR UPPER(d.${k.number}) = $1)` : `d.wa_delivery_status = 'FAILED'`;
    return `SELECT '${kind}' AS kind, d.id, d.${k.number} AS number, ${l.date} AS doc_date, b.booking_code, ${l.amount} AS amount,
                   d.wa_delivery_status, d.wa_sent_at, d.wa_last_error, d.place_of_supply_code IS NOT NULL AS pos_set
            FROM ${k.table} d JOIN crm_bookings b ON b.id = d.booking_id
            WHERE ${k.issued} AND ${filter}`;
  });
  const r = await query(`${parts.join(' UNION ALL ')} ORDER BY doc_date DESC NULLS LAST, kind, id DESC LIMIT 100`, q ? [q] : []);
  return r.rows.map((x) => ({
    kind: x.kind, id: Number(x.id), number: x.number, date: x.doc_date, bookingCode: x.booking_code, amount: Number(x.amount),
    deliveryStatus: x.wa_delivery_status, sentAt: x.wa_sent_at, lastError: x.wa_last_error, placeOfSupplySet: x.pos_set,
  }));
}
