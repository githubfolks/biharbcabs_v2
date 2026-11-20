'use client';

import { useCallback, useEffect, useState } from 'react';

interface GstDocumentRow {
  kind: 'TI' | 'RV' | 'RF' | 'CC';
  id: number;
  number: string;
  date: string;
  bookingCode: string;
  amount: number;
  deliveryStatus: 'PENDING' | 'SENT' | 'FAILED' | 'NOT_SENT';
  sentAt: string | null;
  lastError: string | null;
  placeOfSupplySet: boolean;
}

const KIND_LABEL: Record<GstDocumentRow['kind'], string> = {
  TI: 'Tax invoice',
  RV: 'Receipt voucher',
  RF: 'Refund voucher',
  CC: 'Cancellation charge invoice',
};
const STATUS: Record<GstDocumentRow['deliveryStatus'], { label: string; className: string }> = {
  SENT: { label: 'Sent on WhatsApp', className: 'text-emerald-700' },
  PENDING: { label: 'Waiting to send', className: 'text-slate-600' },
  FAILED: { label: 'Not sent: send by hand', className: 'text-rose-700 font-semibold' },
  NOT_SENT: { label: 'Issued before WhatsApp sending', className: 'text-slate-500' },
};
const keyOf = (d: GstDocumentRow) => `${d.kind}-${d.id}`;

/**
 * GST documents on the Finance page: those WhatsApp could not deliver (shown by default), or any found by
 * booking code or document number, each with its PDF to download and send by hand.
 * Hidden for roles that cannot see the ledger.
 */
export default function GstDocumentsPanel() {
  const [documents, setDocuments] = useState<GstDocumentRow[]>([]);
  const [search, setSearch] = useState('');
  const [shownFor, setShownFor] = useState('');
  const [hidden, setHidden] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  const load = useCallback(async (q: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/finance/gst-documents?q=${encodeURIComponent(q)}`);
      if (res.status === 401 || res.status === 403) return setHidden(true);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not load documents');
      setDocuments(data.documents);
      setShownFor(data.search || '');
      setError(null);
    } catch (err: any) {
      setError(err?.message || 'Could not load documents');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load('');
  }, [load]);

  /** Fetch the PDF first, so a refusal (no GSTIN, no place of supply) is shown instead of saved as a file. */
  async function download(d: GstDocumentRow) {
    setBusy(keyOf(d));
    setDownloadError(null);
    try {
      const res = await fetch(`/api/finance/gst-documents/${d.kind}/${d.id}/pdf`);
      if (!res.ok || !(res.headers.get('content-type') || '').includes('application/pdf')) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Could not download ${d.number}`);
      }
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = `${d.number}.pdf`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setDownloadError(`${d.number}: ${err?.message || 'download failed'}`);
    } finally {
      setBusy(null);
    }
  }

  if (hidden) return null;

  return (
    <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-slate-50">
        <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">GST Documents</h3>
        <p className="text-[11px] text-slate-500 mt-0.5">
          Tax invoices, receipt and refund vouchers, and cancellation charge invoices. Customers get them on WhatsApp; download one here to send by hand.
        </p>
        <form
          className="flex flex-col sm:flex-row gap-2 mt-2"
          onSubmit={(e) => {
            e.preventDefault();
            load(search);
          }}
        >
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Booking code or document number (e.g. BC-K536KL, TI2627000001)"
            className="flex-1 border border-slate-300 rounded px-2 py-1 text-sm"
          />
          <div className="flex gap-2">
            <button type="submit" className="px-3 py-1 text-xs font-medium rounded-md bg-slate-800 text-white hover:bg-slate-700">Search</button>
            {shownFor && (
              <button type="button" onClick={() => { setSearch(''); load(''); }} className="px-3 py-1 text-xs font-medium rounded-md border border-slate-300 text-slate-700">
                Show undelivered
              </button>
            )}
          </div>
        </form>
      </div>
      {downloadError && <div className="px-4 py-2 text-sm text-rose-700 border-b">{downloadError}</div>}
      {error ? (
        <div className="px-4 py-3 text-sm text-rose-700">{error}</div>
      ) : loading ? (
        <div className="px-4 py-3 text-sm text-slate-500">Loading…</div>
      ) : documents.length === 0 ? (
        <div className="px-4 py-3 text-sm text-slate-500">
          {shownFor ? `No GST documents for “${shownFor}”.` : 'Every GST document has been delivered or is waiting to send. Search to find one.'}
        </div>
      ) : (
        <div className="overflow-x-auto">
          {!shownFor && <div className="px-4 pt-2 text-[11px] text-rose-700">WhatsApp could not deliver these. Download each and send it to the customer.</div>}
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
              <tr>
                <th className="px-4 py-2">Document</th>
                <th className="px-4 py-2">Date</th>
                <th className="px-4 py-2">Booking</th>
                <th className="px-4 py-2 text-right">Amount</th>
                <th className="px-4 py-2">WhatsApp</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {documents.map((d) => (
                <tr key={keyOf(d)}>
                  <td className="px-4 py-2">
                    <div className="text-[11px] text-slate-500">{KIND_LABEL[d.kind]}</div>
                    <span className="font-mono text-xs">{d.number}</span>
                  </td>
                  <td className="px-4 py-2 whitespace-nowrap">
                    {d.date ? new Date(d.date).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' }) : '—'}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">#{d.bookingCode}</td>
                  <td className="px-4 py-2 text-right">₹{d.amount.toFixed(2)}</td>
                  <td className="px-4 py-2 text-xs">
                    <span className={STATUS[d.deliveryStatus].className}>{STATUS[d.deliveryStatus].label}</span>
                    {d.deliveryStatus === 'FAILED' && d.lastError && <div className="text-[11px] text-slate-500 max-w-xs break-words">{d.lastError}</div>}
                  </td>
                  <td className="px-4 py-2 text-right">
                    {d.placeOfSupplySet ? (
                      <button
                        onClick={() => download(d)}
                        disabled={busy === keyOf(d)}
                        className="px-3 py-1 text-xs font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50 whitespace-nowrap"
                      >
                        {busy === keyOf(d) ? 'Preparing…' : 'Download PDF'}
                      </button>
                    ) : (
                      <span className="text-[11px] text-amber-700">Choose its place of supply first</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
