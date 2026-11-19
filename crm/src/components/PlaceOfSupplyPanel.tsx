'use client';

import { useCallback, useEffect, useState } from 'react';
import { GST_STATES, stateLabel } from '@/lib/gst-states';

interface WaitingDocument {
  kind: "TI" | "RV" | "CC";
  id: number;
  number: string;
  bookingCode: string;
  pickupCity: string;
  customerGstin: string | null;
  tax: number;
  createdAt: string;
}

const KIND_LABEL: Record<WaitingDocument["kind"], string> = { TI: "Ride invoice", RV: "Receipt voucher", CC: "Cancellation charge" };
const keyOf = (d: WaitingDocument) => `${d.kind}-${d.id}`;

const STATE_OPTIONS = Object.keys(GST_STATES).sort((a, b) => GST_STATES[a].localeCompare(GST_STATES[b]));

/**
 * GST documents (ride invoices, receipt vouchers, cancellation charges) whose place of supply could not be worked out (pickup city not in the list, or a
 * malformed customer GSTIN). Finance chooses the state, which sets the CGST/SGST or IGST split.
 * A receipt voucher's refund vouchers and cancellation charges follow it. Shown only while documents are
 * waiting; hidden for roles that cannot see them.
 */
export default function PlaceOfSupplyPanel() {
  const [invoices, setInvoices] = useState<WaitingDocument[]>([]);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<string, { stateCode: string; remember: boolean }>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/finance/gst-documents/place-of-supply');
      if (res.status === 401 || res.status === 403) return setHidden(true);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not load documents');
      setInvoices(data.documents);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load documents');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(inv: WaitingDocument) {
    const c = choice[keyOf(inv)];
    if (!c?.stateCode) return;
    setBusyId(keyOf(inv));
    setMessage(null);
    try {
      const res = await fetch(`/api/finance/gst-documents/${inv.kind}/${inv.id}/place-of-supply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stateCode: c.stateCode, rememberCity: c.remember }),
      });
      const data = await res.json();
      if (data.success) {
        const tax = data.split.supplyType === 'INTRA_STATE' ? `CGST ₹${data.split.cgst} + SGST ₹${data.split.sgst}` : `IGST ₹${data.split.igst}`;
        setMessage(`${data.number}: place of supply ${stateLabel(c.stateCode)}, ${tax}${data.documentsUpdated > 1 ? ` (and ${data.documentsUpdated - 1} refund or cancellation document(s) of this voucher)` : ''}.${c.remember ? (data.cityRemembered ? ` ${inv.pickupCity} is now listed.` : ` ${inv.pickupCity} was already listed and was not changed.`) : ''}`);
      } else {
        setMessage(data.error || 'Could not set the place of supply');
      }
      await load();
    } catch {
      setMessage('Could not set the place of supply: network error');
    } finally {
      setBusyId(null);
    }
  }

  if (hidden) return null;
  if (loadError) {
    return (
      <div className="bg-white rounded-lg border border-rose-200 p-4 text-sm text-rose-700">
        Documents waiting for place of supply: {loadError}. <button onClick={load} className="underline font-medium">Retry</button>
      </div>
    );
  }
  if (invoices.length === 0 && !message) return null;

  return (
    <div className="bg-white rounded-lg border border-amber-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-amber-50">
        <h3 className="text-xs font-bold uppercase tracking-wider text-amber-800">GST Documents Waiting for Place of Supply ({invoices.length})</h3>
        <p className="text-[11px] text-amber-800 mt-0.5">
          The pickup city is not in the city list, or the customer's GSTIN is not valid, so the CGST/SGST or IGST split is not known.
          Choose the state where the passenger was picked up (or, for a registered customer, the state in their GSTIN).
        </p>
      </div>
      {message && <div className="px-4 py-2 text-sm text-slate-700 border-b">{message}</div>}
      {invoices.length > 0 && (
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
              <tr>
                <th className="px-4 py-2">Document</th>
                <th className="px-4 py-2">Booking</th>
                <th className="px-4 py-2">Pickup city</th>
                <th className="px-4 py-2 text-right">GST</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.map((inv) => {
                const c = choice[keyOf(inv)] || { stateCode: '', remember: !inv.customerGstin };
                const set = (patch: Partial<typeof c>) => setChoice({ ...choice, [keyOf(inv)]: { ...c, ...patch } });
                return (
                  <tr key={keyOf(inv)}>
                    <td className="px-4 py-2"><div className="text-[11px] text-slate-500">{KIND_LABEL[inv.kind]}</div><span className="font-mono text-xs">{inv.number}</span></td>
                    <td className="px-4 py-2 font-mono text-xs">#{inv.bookingCode}</td>
                    <td className="px-4 py-2">
                      {inv.pickupCity}
                      {inv.customerGstin && <div className="text-[11px] text-rose-700">GSTIN not valid: {inv.customerGstin}</div>}
                    </td>
                    <td className="px-4 py-2 text-right">₹{inv.tax.toFixed(2)}</td>
                    <td className="px-4 py-2">
                      <select value={c.stateCode} onChange={(e) => set({ stateCode: e.target.value })} className="border border-slate-300 rounded px-2 py-1 text-sm">
                        <option value="">Choose state…</option>
                        {STATE_OPTIONS.map((code) => <option key={code} value={code}>{stateLabel(code)}</option>)}
                      </select>
                      {!inv.customerGstin && (
                        <label className="flex items-center gap-1 mt-1 text-[11px] text-slate-600">
                          <input type="checkbox" checked={c.remember} onChange={(e) => set({ remember: e.target.checked })} />
                          Remember {inv.pickupCity} for later rides
                        </label>
                      )}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => save(inv)}
                        disabled={!c.stateCode || busyId === keyOf(inv)}
                        className="px-3 py-1 text-xs font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {busyId === keyOf(inv) ? 'Saving…' : 'Save'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
