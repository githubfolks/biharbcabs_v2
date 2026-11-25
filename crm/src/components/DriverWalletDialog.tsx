'use client';

/**
 * A driver's wallet balance and ledger entries (read-only, ledger.view). Entries are listed as recorded,
 * without a running total: they do not add up line by line to the balance (see lib/driver-wallet.ts).
 */
import { useEffect, useState } from 'react';
import { RefreshCw, Wallet, X } from 'lucide-react';

const inr = (n: number) => `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function DriverWalletDialog({ driverId, onClose }: { driverId: number; onClose: () => void }) {
  const [data, setData] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError(null);
    fetch(`/api/drivers/${driverId}/wallet`)
      .then(async (res) => {
        const body = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (res.ok && body.success) setData(body);
        else setError(body.error || `Could not load the wallet (HTTP ${res.status})`);
      })
      .catch(() => !cancelled && setError('Could not load the wallet: network error'));
    return () => {
      cancelled = true;
    };
  }, [driverId]);

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-start sm:items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full p-4 sm:p-6 space-y-4 my-4">
        <div className="flex justify-between items-center border-b pb-3">
          <h3 className="text-lg font-bold text-slate-900 flex items-center">
            <Wallet className="h-5 w-5 mr-1.5 text-emerald-600" />
            Wallet{data ? `: ${data.driver.full_name}` : ''}
          </h3>
          <button onClick={onClose} className="text-slate-600 hover:text-slate-900" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {error ? (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-700">{error}</div>
        ) : !data ? (
          <div className="py-10 flex justify-center items-center text-slate-600 text-sm">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading wallet...
          </div>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3 text-center">
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div className="text-[11px] font-semibold text-slate-500 uppercase">Wallet balance</div>
                <div className={`text-lg font-black font-mono ${data.driver.wallet_balance < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                  {inr(data.driver.wallet_balance)}
                </div>
                <div className="text-[10px] text-slate-500">
                  {data.driver.wallet_balance < 0 ? 'Driver owes BiharCabs' : data.driver.wallet_balance > 0 ? 'BiharCabs owes the driver' : 'Settled'}
                </div>
              </div>
              <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
                <div className="text-[11px] font-semibold text-slate-500 uppercase">Security reserve</div>
                <div className="text-lg font-black font-mono text-indigo-700">{inr(data.driver.security_reserve_balance)}</div>
              </div>
            </div>

            <p className="text-[11px] text-slate-500">
              Ledger entries as recorded, newest first{data.totalEntries > data.entries.length ? ` (latest ${data.entries.length} of ${data.totalEntries})` : ''}. They are not a running
              balance: a trip settlement records its net amount and also lists the reserve deduction and streak bonus inside it, and cash
              collected from customers is recorded without moving the wallet.
            </p>

            {data.entries.length === 0 ? (
              <p className="text-sm text-slate-500 italic text-center py-6">No ledger entries for this driver yet.</p>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                <table className="min-w-full text-xs text-left divide-y divide-slate-200">
                  <thead className="bg-slate-50 text-slate-600 uppercase text-[10px] font-semibold">
                    <tr>
                      <th className="px-3 py-2">When</th>
                      <th className="px-3 py-2">Type</th>
                      <th className="px-3 py-2 text-right">Amount</th>
                      <th className="px-3 py-2">Ride / reference</th>
                      <th className="px-3 py-2">Notes</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.entries.map((e: any) => (
                      <tr key={e.id}>
                        <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                          {new Date(e.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {String(e.transaction_type).replace(/_/g, ' ')}
                          <div className="text-[10px] text-slate-600">{e.payment_channel}</div>
                        </td>
                        <td className={`px-3 py-2 text-right font-mono font-semibold whitespace-nowrap ${e.direction === 'DEBIT' ? 'text-rose-600' : 'text-emerald-700'}`}>
                          {e.direction === 'DEBIT' ? '−' : '+'}
                          {inr(e.amount)}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {e.booking_code || '—'}
                          {e.reference_id && <div className="text-[10px] text-slate-600 font-mono">{e.reference_id}</div>}
                        </td>
                        <td className="px-3 py-2 text-slate-600 min-w-[12rem] break-words">
                          {e.notes || ''}
                          {e.recorded_by_name && <div className="text-[10px] text-slate-600">by {e.recorded_by_name}</div>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
