import PDFDocument from 'pdfkit';
import { query } from './db';
import { getCompanyBillingInfo } from './settings';
import { stateCodeFromGstin, stateLabel } from './gst-states';
import { round2 } from './fare-split';

/**
 * PDFs of the GST documents BiharCabs issues to customers (per CA, Section 31 CGST Act):
 *   TI tax invoice for a ride (Rule 46), RV receipt voucher (Rule 50), RF refund voucher (Rule 51),
 *   CC tax invoice for a cancellation charge (Rule 46).
 * Each shows BiharCabs' and the customer's details, the number and date, the place of supply, the SAC,
 * the CGST + SGST or IGST lines, and whether tax is payable on reverse charge. A document is refused
 * while BiharCabs' GSTIN or its place of supply is missing: it would not be a valid document.
 *
 * Amounts are printed as "Rs.": PDFKit's built-in fonts have no rupee sign.
 */

export type GstDocumentKind = 'TI' | 'RV' | 'RF' | 'CC';
export const GST_DOCUMENT_KINDS: readonly GstDocumentKind[] = ['TI', 'RV', 'RF', 'CC'];

export class GstPdfError extends Error {
  constructor(message: string, public status = 409) {
    super(message);
  }
}

interface TaxedDoc {
  supplier_state_code?: string | null;
  place_of_supply_code?: string | null;
  cgst_amount?: any;
  sgst_amount?: any;
  igst_amount?: any;
}

/** CGST + SGST at half the rate each within BiharCabs' state, otherwise IGST at the full rate. */
export function taxLines(doc: TaxedDoc, ratePct: number): { label: string; amount: number }[] {
  if (!doc.place_of_supply_code || !doc.supplier_state_code) throw new GstPdfError('The place of supply is not set yet; choose it on the Finance page.');
  const half = round2(ratePct / 2);
  return doc.supplier_state_code !== doc.place_of_supply_code
    ? [{ label: `IGST @ ${ratePct}%`, amount: Number(doc.igst_amount) }]
    : [
        { label: `CGST @ ${half}%`, amount: Number(doc.cgst_amount) },
        { label: `SGST @ ${half}%`, amount: Number(doc.sgst_amount) },
      ];
}

/** The rate a document was issued at, from its own amounts (GST included in the total). */
const rateFrom = (tax: number, taxable: number) => (taxable > 0 ? round2((tax * 100) / taxable) : 0);

interface PdfModel {
  title: string;
  number: string;
  date: Date | string;
  bookingCode: string;
  trip: string;
  references: string[];
  customer: { name: string | null; phone: string | null; gstin: string | null };
  lines: { description: string; amount: number }[];
  taxableValue: number;
  tax: TaxedDoc;
  ratePct: number;
  totalLabel: string;
  total: number;
}

const money = (n: number) => `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateText = (d: Date | string) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' });

const BOOKING_SQL = `b.booking_code, b.origin_city, b.destination_city, b.trip_type,
  c.full_name AS customer_name, c.phone AS customer_phone, NULLIF(TRIM(c.gstin), '') AS customer_gstin`;

async function load(kind: GstDocumentKind, id: number): Promise<PdfModel> {
  const one = async (sql: string) => {
    const r = (await query(sql, [id])).rows[0];
    if (!r) throw new GstPdfError('Document not found', 404);
    return r;
  };
  const common = (r: any) => ({
    bookingCode: r.booking_code,
    trip: `${r.origin_city} to ${r.destination_city || 'Local'} (${r.trip_type})`,
    customer: { name: r.customer_name, phone: r.customer_phone, gstin: r.customer_gstin },
    tax: r as TaxedDoc,
  });

  if (kind === 'TI') {
    const r = await one(`SELECT i.*, ${BOOKING_SQL} FROM crm_invoices i JOIN crm_bookings b ON b.id = i.booking_id
                         JOIN crm_customers c ON c.id = b.customer_id WHERE i.id = $1`);
    const tolls = round2(Number(r.total_amount) - Number(r.subtotal) - Number(r.tax_amount));
    return {
      ...common(r), title: 'TAX INVOICE', number: r.invoice_number, date: r.created_at, references: [],
      lines: (r.line_items || []).map((x: any) => ({ description: x.description, amount: Number(x.amount) })),
      taxableValue: Number(r.subtotal), ratePct: rateFrom(Number(r.tax_amount), Number(r.subtotal)),
      totalLabel: tolls > 0 ? 'Total (incl. tolls/parking at actuals, no GST)' : 'Total', total: Number(r.total_amount),
    };
  }
  if (kind === 'RV') {
    const r = await one(`SELECT l.*, ${BOOKING_SQL} FROM crm_payment_links l JOIN crm_bookings b ON b.id = l.booking_id
                         JOIN crm_customers c ON c.id = b.customer_id WHERE l.id = $1 AND l.receipt_voucher_number IS NOT NULL`);
    const amount = Number(r.amount_paise) / 100;
    const taxable = round2(amount - Number(r.gst_amount));
    return {
      ...common(r), title: 'RECEIPT VOUCHER', number: r.receipt_voucher_number, date: r.paid_at, references: [],
      lines: [{ description: `Advance received for passenger transport, booking #${r.booking_code}`, amount }],
      taxableValue: taxable, ratePct: r.gst_pct != null ? Number(r.gst_pct) : rateFrom(Number(r.gst_amount), taxable),
      totalLabel: 'Advance received', total: amount,
    };
  }
  if (kind === 'RF') {
    const r = await one(`SELECT f.*, l.gst_pct AS rv_gst_pct, ${BOOKING_SQL} FROM crm_refunds f JOIN crm_bookings b ON b.id = f.booking_id
                         JOIN crm_customers c ON c.id = b.customer_id
                         LEFT JOIN crm_payment_links l ON l.receipt_voucher_number = f.receipt_voucher_number
                         WHERE f.id = $1 AND f.refund_voucher_number IS NOT NULL`);
    if (r.gst_reversed == null) throw new GstPdfError('This refund voucher has no GST recorded; finance must check it.');
    const amount = Number(r.amount_paise) / 100;
    const taxable = round2(amount - Number(r.gst_reversed));
    return {
      ...common(r), title: 'REFUND VOUCHER', number: r.refund_voucher_number, date: r.refund_voucher_date,
      references: r.receipt_voucher_number ? [`Against receipt voucher ${r.receipt_voucher_number} dated ${dateText(r.receipt_voucher_date)}`] : [],
      lines: [{ description: `Refund of advance, booking #${r.booking_code}`, amount }],
      taxableValue: taxable, ratePct: r.rv_gst_pct != null ? Number(r.rv_gst_pct) : rateFrom(Number(r.gst_reversed), taxable),
      totalLabel: 'Amount refunded', total: amount,
    };
  }
  const r = await one(`SELECT x.*, ${BOOKING_SQL} FROM crm_cancellation_charges x JOIN crm_bookings b ON b.id = x.booking_id
                       JOIN crm_customers c ON c.id = b.customer_id WHERE x.id = $1 AND x.status = 'ISSUED'`);
  return {
    ...common(r), title: 'TAX INVOICE (CANCELLATION CHARGE)', number: r.invoice_number, date: r.invoice_date,
    references: r.receipt_voucher_number ? [`Advance received under receipt voucher ${r.receipt_voucher_number} dated ${dateText(r.receipt_voucher_date)}`] : [],
    lines: [{ description: `Cancellation charge: advance retained on late cancellation of booking #${r.booking_code}`, amount: Number(r.amount) }],
    taxableValue: Number(r.taxable_value), ratePct: Number(r.gst_pct),
    totalLabel: 'Total', total: Number(r.amount),
  };
}

/** The PDF of one issued GST document. */
export async function gstDocumentPdf(kind: GstDocumentKind, id: number): Promise<{ buffer: Buffer; fileName: string; number: string }> {
  if (!GST_DOCUMENT_KINDS.includes(kind)) throw new GstPdfError('Unknown document type', 400);
  if (!Number.isSafeInteger(id) || id <= 0) throw new GstPdfError('Invalid document', 400);
  const company: any = await getCompanyBillingInfo();
  if (!stateCodeFromGstin(company?.gstin)) throw new GstPdfError('BiharCabs\' GSTIN is not set (company_billing_info.gstin); a tax document needs it.');
  const m = await load(kind, id);
  const lines = taxLines(m.tax, m.ratePct);
  return { buffer: await render(company, m, lines), fileName: `${m.number}.pdf`, number: m.number };
}

function render(company: any, m: PdfModel, tax: { label: string; amount: number }[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 40, size: 'A4', info: { Title: `${m.title} ${m.number}`, Author: company.legal_name || 'BiharCabs' } });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fillColor('#ea580c').fontSize(20).font('Helvetica-Bold').text(company.trade_name || company.legal_name);
    doc.fillColor('#333333').fontSize(9).font('Helvetica').text(company.legal_name);
    doc.text(company.address);
    doc.text(`GSTIN: ${company.gstin}`);
    doc.text(`Phone: ${company.phone} | Email: ${company.email}`);
    doc.moveDown(0.8);
    doc.strokeColor('#e5e7eb').lineWidth(1).moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.8);

    const top = doc.y;
    doc.font('Helvetica-Bold').fontSize(12).text(`${m.title}`, 40, top);
    doc.font('Helvetica').fontSize(9);
    doc.text(`Number: ${m.number}`);
    doc.text(`Date: ${dateText(m.date)}`);
    doc.text(`Booking: #${m.bookingCode}`);
    doc.text(`Trip: ${m.trip}`);
    doc.text(`Place of supply: ${stateLabel(m.tax.place_of_supply_code as string)}`);
    if (company.hsn_sac) doc.text(`SAC: ${company.hsn_sac}`);
    doc.text('Tax payable on reverse charge: No');
    for (const ref of m.references) doc.text(ref);
    const leftEnd = doc.y;

    doc.font('Helvetica-Bold').fontSize(10).text('Issued to:', 330, top);
    doc.font('Helvetica').fontSize(9).text(m.customer.name || 'Customer', 330);
    if (m.customer.phone) doc.text(`Phone: ${m.customer.phone}`, 330);
    if (m.customer.gstin) doc.text(`GSTIN: ${m.customer.gstin}`, 330);

    let y = Math.max(leftEnd, doc.y) + 20;
    doc.font('Helvetica-Bold').fontSize(10).text('Description', 40, y);
    doc.text('Amount', 455, y, { width: 100, align: 'right' });
    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(40, y + 14).lineTo(555, y + 14).stroke();
    y += 22;
    doc.font('Helvetica').fontSize(9);
    for (const line of m.lines) {
      doc.text(line.description, 40, y, { width: 400 });
      doc.text(money(line.amount), 455, y, { width: 100, align: 'right' });
      y = Math.max(doc.y, y + 14) + 4;
    }
    doc.strokeColor('#cccccc').lineWidth(0.5).moveTo(40, y).lineTo(555, y).stroke();
    y += 10;

    const row = (label: string, amount: number, bold = false) => {
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 11 : 9);
      doc.text(label, 250, y, { width: 200, align: 'right' });
      doc.text(money(amount), 455, y, { width: 100, align: 'right' });
      y += bold ? 18 : 15;
    };
    row('Taxable value', m.taxableValue);
    for (const t of tax) row(`${t.label} (included)`, t.amount);
    row(m.totalLabel, m.total, true);

    doc.font('Helvetica').fontSize(9).fillColor('#333333')
      .text(`For ${company.legal_name}`, 330, y + 30, { width: 225, align: 'right' })
      .text('Authorised signatory', 330, y + 60, { width: 225, align: 'right' });
    doc.fontSize(8).font('Helvetica-Oblique').fillColor('#666666')
      .text('This is a computer-generated document.', 40, 770, { width: 515, align: 'center' });
    doc.end();
  });
}
