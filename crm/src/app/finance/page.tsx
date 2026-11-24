'use client';

import { useState, useEffect } from 'react';
import { 
  DollarSign, Wallet, FileText, CheckCircle, RefreshCw, ArrowUpRight, 
  ArrowDownLeft, ShieldCheck, Landmark, Gift, AlertCircle, Percent 
} from 'lucide-react';
import PlaceOfSupplyPanel from '@/components/PlaceOfSupplyPanel';
import GstDocumentsPanel from '@/components/GstDocumentsPanel';

export default function FinancePage() {
  const [ledger, setLedger] = useState<any[]>([]);
  const [summary, setSummary] = useState<any>({
    totalCommissionRevenue: 0,
    totalGstStatutory: 0,
    totalRideGst: 0,
    totalCommissionGst: 0,
    totalTechFees: 0,
    totalSecurityReserveHeld: 0,
    totalDriverDuesOutstanding: 0,
    totalIncentivesAwarded: 0,
  });
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState('ALL');

  // Drivers BiharCabs owes money to, and the payout being recorded
  const [owedDrivers, setOwedDrivers] = useState<any[]>([]);
  const [owedError, setOwedError] = useState<string | null>(null);
  const [payoutDriver, setPayoutDriver] = useState<any | null>(null);
  const [payoutForm, setPayoutForm] = useState({ amount: '', channel: 'UPI', reference: '', notes: '' });
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [savingPayout, setSavingPayout] = useState(false);

  async function loadOwedDrivers() {
    try {
      const res = await fetch('/api/finance/payouts');
      const data = await res.json();
      if (data.success) {
        setOwedDrivers(data.drivers);
        setOwedError(null);
      } else {
        setOwedError(data.error || 'Could not load drivers owed money');
      }
    } catch {
      setOwedError('Could not load drivers owed money');
    }
  }

  function openPayout(driver: any) {
    setPayoutDriver(driver);
    setPayoutForm({ amount: String(driver.wallet_balance), channel: 'UPI', reference: '', notes: '' });
    setPayoutError(null);
  }

  async function handleRecordPayout(e: React.FormEvent) {
    e.preventDefault();
    if (!payoutDriver) return;
    setSavingPayout(true);
    setPayoutError(null);
    try {
      const res = await fetch('/api/finance/payouts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverId: payoutDriver.id, ...payoutForm, amount: Number(payoutForm.amount) }),
      });
      const data = await res.json();
      if (data.success) {
        setPayoutDriver(null);
        loadOwedDrivers();
        loadFinance(typeFilter);
      } else {
        setPayoutError(data.error || 'Payout not recorded');
      }
    } catch {
      setPayoutError('Payout not recorded: network error');
    } finally {
      setSavingPayout(false);
    }
  }

  // Drivers who owe BiharCabs dues, and the payment being recorded
  const [owingDrivers, setOwingDrivers] = useState<any[]>([]);
  const [owingError, setOwingError] = useState<string | null>(null);
  const [duesDriver, setDuesDriver] = useState<any | null>(null);
  const [duesForm, setDuesForm] = useState({ amount: '', channel: 'UPI', reference: '', notes: '' });
  const [duesError, setDuesError] = useState<string | null>(null);
  const [savingDues, setSavingDues] = useState(false);

  async function loadOwingDrivers() {
    try {
      const res = await fetch('/api/finance/dues-payments');
      const data = await res.json();
      if (data.success) {
        setOwingDrivers(data.drivers);
        setOwingError(null);
      } else {
        setOwingError(data.error || 'Could not load drivers owing dues');
      }
    } catch {
      setOwingError('Could not load drivers owing dues');
    }
  }

  async function handleRecordDues(e: React.FormEvent) {
    e.preventDefault();
    if (!duesDriver) return;
    setSavingDues(true);
    setDuesError(null);
    try {
      const res = await fetch('/api/finance/dues-payments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ driverId: duesDriver.id, ...duesForm, amount: Number(duesForm.amount) }),
      });
      const data = await res.json();
      if (data.success) {
        setDuesDriver(null);
        loadOwingDrivers();
        loadOwedDrivers();
        loadFinance(typeFilter);
      } else {
        setDuesError(data.error || 'Payment not recorded');
      }
    } catch {
      setDuesError('Payment not recorded: network error');
    } finally {
      setSavingDues(false);
    }
  }

  useEffect(() => {
    loadOwedDrivers();
    loadOwingDrivers();
  }, []);

  async function loadFinance(filter = typeFilter) {
    setLoading(true);
    try {
      const url = filter === 'ALL' ? '/api/finance/ledger' : `/api/finance/ledger?type=${filter}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setLedger(data.ledger);
        if (data.summary) {
          setSummary(data.summary);
        }
      }
    } catch (err) {
      console.error('Failed to load finance ledger:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadFinance(typeFilter);
  }, [typeFilter]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Finance &amp; Statutory GST Reconciliation</h1>
          <p className="text-sm text-slate-500">CGST Sec 9(5) Tax Splits, Platform Facilitation, Rolling Reserve Floats &amp; Driver Wallets</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => loadFinance(typeFilter)}
            className="inline-flex items-center px-3 py-2 border border-slate-300 shadow-sm text-sm font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {/* Card 1: Platform Facilitation (3%) */}
        <div className="min-w-0 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-semibold uppercase">
            <span>Facilitation (3%)</span>
            <DollarSign className="h-4 w-4 text-emerald-600" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-slate-900">
            ₹{Number(summary.totalCommissionRevenue).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">Net facilitation fees earned</p>
        </div>

        {/* Card 2: GST on rides: 5% ride GST (Sec 9(5)) + 18% on commission and tech fee */}
        <div className="min-w-0 bg-white p-4 rounded-xl border border-blue-200 shadow-sm bg-blue-50/20">
          <div className="flex items-center justify-between text-blue-800 text-xs font-semibold uppercase">
            <span>GST on Rides</span>
            <Percent className="h-4 w-4 text-blue-600" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-blue-900">
            ₹{Number(summary.totalGstStatutory).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-[10px] text-blue-600/80 mt-1">
            5% ride GST ₹{Number(summary.totalRideGst).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
            {Number(summary.totalCommissionGst) > 0
              ? ` + commission GST ₹${Number(summary.totalCommissionGst).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`
              : ''}
            . Completed rides.
          </p>
        </div>

        {/* Card 3: Platform Charge */}
        <div className="min-w-0 bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between text-slate-500 text-xs font-semibold uppercase">
            <span>Platform Charge (₹10)</span>
            <ShieldCheck className="h-4 w-4 text-indigo-600" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-slate-900">
            ₹{Number(summary.totalTechFees).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-[10px] text-slate-400 mt-1">Platform charge collected on completed rides</p>
        </div>

        {/* Card 4: Security Reserve Float */}
        <div className="min-w-0 bg-white p-4 rounded-xl border border-purple-200 shadow-sm bg-purple-50/20">
          <div className="flex items-center justify-between text-purple-800 text-xs font-semibold uppercase">
            <span>Reserve Float Held</span>
            <Landmark className="h-4 w-4 text-purple-600" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-purple-900">
            ₹{Number(summary.totalSecurityReserveHeld).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-[10px] text-purple-600/80 mt-1">Porter model cash float</p>
        </div>

        {/* Card 5: Outstanding Dues */}
        <div className="min-w-0 bg-white p-4 rounded-xl border border-rose-200 shadow-sm bg-rose-50/20">
          <div className="flex items-center justify-between text-rose-800 text-xs font-semibold uppercase">
            <span>Fleet Dues At Risk</span>
            <AlertCircle className="h-4 w-4 text-rose-600" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-rose-900">
            ₹{Number(summary.totalDriverDuesOutstanding).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-[10px] text-rose-600/80 mt-1">Covered by leeway &amp; reserves</p>
        </div>

        {/* Card 6: Incentives Awarded */}
        <div className="min-w-0 bg-white p-4 rounded-xl border border-amber-200 shadow-sm bg-amber-50/20">
          <div className="flex items-center justify-between text-amber-800 text-xs font-semibold uppercase">
            <span>Incentives &amp; Streaks</span>
            <Gift className="h-4 w-4 text-amber-600" />
          </div>
          <div className="mt-2 text-xl font-bold font-mono tabular-nums [overflow-wrap:anywhere] text-amber-900">
            ₹{Number(summary.totalIncentivesAwarded).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
          </div>
          <p className="text-[10px] text-amber-600/80 mt-1">Auto-routed to clear debt</p>
        </div>
      </div>

      {/* Drivers BiharCabs owes money to */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Drivers Owed Money ({owedDrivers.length})
          </h3>
        </div>
        {owedError ? (
          <div className="px-4 py-3 text-sm text-rose-600">{owedError}</div>
        ) : owedDrivers.length === 0 ? (
          <div className="px-4 py-3 text-sm text-slate-500">BiharCabs owes no driver money right now.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
                <tr>
                  <th className="px-4 py-2">Driver</th>
                  <th className="px-4 py-2">Owed</th>
                  <th className="px-4 py-2">Last payout</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {owedDrivers.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{d.full_name}</div>
                      <div className="text-xs text-slate-500">{d.phone}</div>
                    </td>
                    <td className="px-4 py-2 font-semibold text-emerald-700">
                      ₹{Number(d.wallet_balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-500">
                      {d.last_payout_at ? new Date(d.last_payout_at).toLocaleString('en-IN') : 'Never'}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => openPayout(d)}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold bg-slate-900 text-white hover:bg-slate-700"
                      >
                        Record payout
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Drivers who owe BiharCabs dues */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Drivers Owing Dues ({owingDrivers.length})
          </h3>
          <p className="text-[11px] text-slate-500 mt-0.5">Payments made through the driver&apos;s Razorpay link are recorded automatically. Record UPI to the company VPA, bank transfers and cash here.</p>
        </div>
        {owingError ? (
          <div className="px-4 py-3 text-sm text-rose-600">{owingError}</div>
        ) : owingDrivers.length === 0 ? (
          <div className="px-4 py-3 text-sm text-slate-500">No driver owes BiharCabs dues right now.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
                <tr>
                  <th className="px-4 py-2">Driver</th>
                  <th className="px-4 py-2">Owes</th>
                  <th className="px-4 py-2">Credit limit</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {owingDrivers.map((d) => (
                  <tr key={d.id}>
                    <td className="px-4 py-2">
                      <div className="font-medium text-slate-900">{d.full_name}</div>
                      <div className="text-xs text-slate-500">{d.phone}</div>
                    </td>
                    <td className={`px-4 py-2 font-semibold ${d.owed > d.credit_limit ? 'text-rose-700' : 'text-amber-700'}`}>
                      ₹{Number(d.owed).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-2 text-xs text-slate-600">₹{Number(d.credit_limit).toLocaleString('en-IN')}</td>
                    <td className="px-4 py-2 text-xs text-slate-600">{String(d.onboarding_status).replace(/_/g, ' ')}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => {
                          setDuesDriver(d);
                          setDuesForm({ amount: String(d.owed), channel: 'UPI', reference: '', notes: '' });
                          setDuesError(null);
                        }}
                        className="px-3 py-1.5 rounded-md text-xs font-semibold bg-slate-900 text-white hover:bg-slate-700"
                      >
                        Record payment
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <PlaceOfSupplyPanel />

      <GstDocumentsPanel />

      {/* Filter Tabs */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 pb-3">
        {[
          { id: 'ALL', label: 'All Transactions' },
          { id: 'DRIVER_COMMISSION_DEDUCTION', label: 'Commission Deductions' },
          { id: 'DRIVER_PLAN_PURCHASE', label: 'Driver Plan Purchases' },
          { id: 'DRIVER_PAYOUT', label: 'Owed to Drivers (Trips)' },
          { id: 'DRIVER_PAYOUT_SENT', label: 'Payouts Sent' },
          { id: 'DRIVER_DUES_PAYMENT', label: 'Dues Received' },
          { id: 'SECURITY_RESERVE_DEPOSIT', label: 'Security Reserve Floats' },
          { id: 'INCENTIVE_STREAK_BONUS', label: 'Ride Streak Bonuses' },
          { id: 'INCENTIVE_BONUS', label: 'Promotional Bonuses' },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setTypeFilter(tab.id)}
            className={`px-3 py-1.5 rounded-full text-xs font-semibold transition ${
              typeFilter === tab.id
                ? 'bg-slate-900 text-white shadow-sm'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Ledger Table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 border-b bg-slate-50 flex justify-between items-center">
          <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700">
            Audit Trail Ledger ({ledger.length} entries)
          </h3>
          <span className="text-[11px] text-slate-400 font-mono">Immutable Double-Entry Ledger</span>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
              <tr>
                <th className="px-4 py-3">Timestamp</th>
                <th className="px-4 py-3">Transaction Type</th>
                <th className="px-4 py-3">Party (Driver / Customer)</th>
                <th className="px-4 py-3">Channel</th>
                <th className="px-4 py-3">Direction</th>
                <th className="px-4 py-3 font-mono">Amount</th>
                <th className="px-4 py-3">Audit Reference &amp; Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-slate-700">
              {ledger.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No ledger transactions found for selected filter.
                  </td>
                </tr>
              ) : (
                ledger.map((tx) => (
                  <tr key={tx.id} className="hover:bg-slate-50/60 transition">
                    <td className="px-4 py-3 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(tx.created_at).toLocaleString('en-IN')}
                    </td>
                    <td className="px-4 py-3 font-semibold text-slate-900 text-xs uppercase font-mono">
                      <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                        tx.transaction_type.includes('RESERVE')
                          ? 'bg-purple-100 text-purple-800'
                          : tx.transaction_type.includes('INCENTIVE')
                          ? 'bg-amber-100 text-amber-800'
                          : tx.transaction_type.includes('COMMISSION')
                          ? 'bg-blue-100 text-blue-800'
                          : 'bg-slate-100 text-slate-800'
                      }`}>
                        {tx.transaction_type.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-xs font-medium">
                      {tx.driver_name ? (
                        <span className="font-semibold text-slate-800">🚖 {tx.driver_name}</span>
                      ) : tx.customer_name ? (
                        <span className="text-slate-700">👤 {tx.customer_name}</span>
                      ) : (
                        <span className="text-slate-400 italic">General</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs uppercase font-mono text-slate-500">
                      {tx.payment_channel}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center text-xs font-semibold px-2 py-0.5 rounded ${
                        tx.direction === 'CREDIT' ? 'bg-emerald-100 text-emerald-800' : 'bg-rose-100 text-rose-800'
                      }`}>
                        {tx.direction === 'CREDIT' ? <ArrowUpRight className="h-3 w-3 mr-0.5" /> : <ArrowDownLeft className="h-3 w-3 mr-0.5" />}
                        {tx.direction}
                      </span>
                    </td>
                    <td className="px-4 py-3 font-mono font-bold text-slate-900">
                      ₹{Number(tx.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      <div>{tx.notes || '—'}</div>
                      {tx.reference_id && (
                        <div className="text-[10px] text-slate-400 font-mono mt-0.5">Ref: {tx.reference_id}</div>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Record Dues Payment Modal */}
      {duesDriver && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleRecordDues} className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Record dues payment from {duesDriver.full_name}</h3>
            <p className="text-xs text-slate-500">
              Owes ₹{Number(duesDriver.owed).toLocaleString('en-IN', { minimumFractionDigits: 2 })}. Record only money BiharCabs has received.
              If the driver is back within their credit limit, their dues restriction is lifted. They are notified on WhatsApp.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Amount received (₹)</label>
              <input type="number" required min="0.01" step="0.01" max={duesDriver.owed} value={duesForm.amount}
                onChange={(e) => setDuesForm({ ...duesForm, amount: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Received by</label>
              <select value={duesForm.channel} onChange={(e) => setDuesForm({ ...duesForm, channel: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm">
                <option value="UPI">UPI (company VPA)</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">{duesForm.channel === 'CASH' ? 'Receipt number' : 'Transaction reference (UTR)'}</label>
              <input required minLength={6} maxLength={100} value={duesForm.reference}
                onChange={(e) => setDuesForm({ ...duesForm, reference: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Notes (optional)</label>
              <input maxLength={500} value={duesForm.notes} onChange={(e) => setDuesForm({ ...duesForm, notes: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm" />
            </div>
            {duesError && <div className="text-sm text-rose-600">{duesError}</div>}
            <div className="flex justify-end space-x-2 pt-2 border-t">
              <button type="button" onClick={() => setDuesDriver(null)} className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50">Cancel</button>
              <button type="submit" disabled={savingDues} className="px-4 py-2 rounded-md text-sm font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
                {savingDues ? 'Recording…' : 'Record payment'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Record Payout Modal */}
      {payoutDriver && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <form onSubmit={handleRecordPayout} className="bg-white rounded-lg shadow-xl w-full max-w-md p-5 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Record payout to {payoutDriver.full_name}</h3>
            <p className="text-xs text-slate-500">
              BiharCabs owes ₹{Number(payoutDriver.wallet_balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}.
              Record only money already sent. The driver is notified on WhatsApp.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Amount paid (₹)</label>
              <input
                type="number"
                required
                min="0.01"
                step="0.01"
                max={payoutDriver.wallet_balance}
                value={payoutForm.amount}
                onChange={(e) => setPayoutForm({ ...payoutForm, amount: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Paid by</label>
              <select
                value={payoutForm.channel}
                onChange={(e) => setPayoutForm({ ...payoutForm, channel: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              >
                <option value="UPI">UPI</option>
                <option value="BANK_TRANSFER">Bank transfer</option>
                <option value="CASH">Cash</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                {payoutForm.channel === 'CASH' ? 'Receipt number' : 'Transaction reference (UTR)'}
              </label>
              <input
                required
                minLength={6}
                maxLength={100}
                value={payoutForm.reference}
                onChange={(e) => setPayoutForm({ ...payoutForm, reference: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Notes (optional)</label>
              <input
                maxLength={500}
                value={payoutForm.notes}
                onChange={(e) => setPayoutForm({ ...payoutForm, notes: e.target.value })}
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>
            {payoutError && <div className="text-sm text-rose-600">{payoutError}</div>}
            <div className="flex justify-end space-x-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setPayoutDriver(null)}
                className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={savingPayout}
                className="px-4 py-2 rounded-md text-sm font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {savingPayout ? 'Recording…' : 'Record payout'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
