'use client';

import { useCallback, useEffect, useState } from 'react';
import { GST_STATES, stateLabel } from '@/lib/gst-states';

interface WaitingInvoice {
  id: number;
  invoiceNumber: string;
  bookingCode: string;
  pickupCity: string;
  customerGstin: string | null;
  totalAmount: number;
  createdAt: string;
}

const STATE_OPTIONS = Object.keys(GST_STATES).sort((a, b) => GST_STATES[a].localeCompare(GST_STATES[b]));

/**
 * Ride invoices whose place of supply could not be worked out (pickup city not in the list, or a
 * malformed customer GSTIN). Finance chooses the state, which sets the CGST/SGST or IGST split.
 * Shown only while invoices are waiting; hidden for roles that cannot see invoices.
 */
export default function PlaceOfSupplyPanel() {
  const [invoices, setInvoices] = useState<WaitingInvoice[]>([]);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [choice, setChoice] = useState<Record<number, { stateCode: string; remember: boolean }>>({});
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/finance/invoices/place-of-supply');
      if (res.status === 401 || res.status === 403) return setHidden(true);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not load invoices');
      setInvoices(data.invoices);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load invoices');
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function save(inv: WaitingInvoice) {
    const c = choice[inv.id];
    if (!c?.stateCode) return;
    setBusyId(inv.id);
    setMessage(null);
    try {
      const res = await fetch(`/api/finance/invoices/${inv.id}/place-of-supply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stateCode: c.stateCode, rememberCity: c.remember }),
      });
      const data = await res.json();
      if (data.success) {
        const tax = data.split.supplyType === 'INTRA_STATE' ? `CGST ₹${data.split.cgst} + SGST ₹${data.split.sgst}` : `IGST ₹${data.split.igst}`;
        setMessage(`${data.invoiceNumber}: place of supply ${stateLabel(c.stateCode)}, ${tax}.${c.remember ? (data.cityRemembered ? ` ${inv.pickupCity} is now listed.` : ` ${inv.pickupCity} was already listed and was not changed.`) : ''}`);
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
        Invoices waiting for place of supply: {loadError}. <button onClick={load} className="underline font-medium">Retry</button>
      </div>
    );
  }
  if (invoices.length === 0 && !message) return null;

  return (
    <div className="bg-white rounded-lg border border-amber-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 border-b bg-amber-50">
        <h3 className="text-xs font-bold uppercase tracking-wider text-amber-800">Invoices Waiting for Place of Supply ({invoices.length})</h3>
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
                <th className="px-4 py-2">Invoice</th>
                <th className="px-4 py-2">Booking</th>
                <th className="px-4 py-2">Pickup city</th>
                <th className="px-4 py-2 text-right">Total</th>
                <th className="px-4 py-2">State</th>
                <th className="px-4 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {invoices.map((inv) => {
                const c = choice[inv.id] || { stateCode: '', remember: !inv.customerGstin };
                const set = (patch: Partial<typeof c>) => setChoice({ ...choice, [inv.id]: { ...c, ...patch } });
                return (
                  <tr key={inv.id}>
                    <td className="px-4 py-2 font-mono text-xs">{inv.invoiceNumber}</td>
                    <td className="px-4 py-2 font-mono text-xs">#{inv.bookingCode}</td>
                    <td className="px-4 py-2">
                      {inv.pickupCity}
                      {inv.customerGstin && <div className="text-[11px] text-rose-700">GSTIN not valid: {inv.customerGstin}</div>}
                    </td>
                    <td className="px-4 py-2 text-right">₹{inv.totalAmount.toFixed(2)}</td>
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
                        disabled={!c.stateCode || busyId === inv.id}
                        className="px-3 py-1 text-xs font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                      >
                        {busyId === inv.id ? 'Saving…' : 'Save'}
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
