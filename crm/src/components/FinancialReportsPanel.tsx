'use client';

import { useState, useEffect, useCallback } from 'react';
import { BarChart3, Download, RefreshCw, Calendar, FileSpreadsheet, AlertTriangle } from 'lucide-react';
import type { FinancialReportType } from '@/lib/financial-reports';

const REPORT_TABS: Array<{ id: FinancialReportType; label: string; desc: string; usesDates: boolean }> = [
  { id: 'pnl', label: 'Revenue & Margin P&L', desc: 'GMV, GST liability, commission, tech fees, incentives & net revenue', usesDates: true },
  { id: 'gstr1', label: 'GSTR-1 Register', desc: 'CA-ready tax invoices with B2B/B2C, Place of Supply & CGST/SGST/IGST', usesDates: true },
  { id: 'dues_aging', label: 'Driver Dues Aging', desc: 'Outstanding cash-ride commission bucketed by 0–7, 8–15, 16–30, 30+ days', usesDates: false },
  { id: 'settlements', label: 'Driver Settlements', desc: 'Per-driver trips, earnings, payouts sent, dues collected & wallet balance', usesDates: true },
  { id: 'reconciliation', label: 'Online & Refunds', desc: 'Razorpay payment links, customer refunds & cancellation charges', usesDates: true },
];

function fmtInr(n: number | undefined | null): string {
  const v = Number(n || 0);
  return `₹${v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getIstToday(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function getIstMonthStart(): string {
  return `${getIstToday().slice(0, 7)}-01`;
}

export default function FinancialReportsPanel() {
  const [report, setReport] = useState<FinancialReportType>('pnl');
  const [from, setFrom] = useState<string>(getIstMonthStart);
  const [to, setTo] = useState<string>(getIstToday);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<any>(null);

  const activeTab = REPORT_TABS.find((t) => t.id === report)!;

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ report });
      if (activeTab.usesDates) {
        sp.set('from', from);
        sp.set('to', to);
      }
      const res = await fetch(`/api/finance/reports?${sp.toString()}`, { cache: 'no-store' });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || 'Could not load financial report');
        setData(null);
      } else {
        setData(json);
      }
    } catch {
      setError('Network error while loading financial report');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [report, from, to, activeTab.usesDates]);

  useEffect(() => {
    loadReport();
  }, [loadReport]);

  function applyPreset(preset: 'this_month' | 'last_month' | 'last_30' | 'this_fy') {
    const todayStr = getIstToday();
    const [y, m] = todayStr.split('-').map(Number);
    if (preset === 'this_month') {
      setFrom(`${y}-${String(m).padStart(2, '0')}-01`);
      setTo(todayStr);
    } else if (preset === 'last_month') {
      const prevM = m === 1 ? 12 : m - 1;
      const prevY = m === 1 ? y - 1 : y;
      const lastDay = new Date(Date.UTC(prevY, prevM, 0)).getUTCDate();
      setFrom(`${prevY}-${String(prevM).padStart(2, '0')}-01`);
      setTo(`${prevY}-${String(prevM).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`);
    } else if (preset === 'last_30') {
      const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000 - 29 * 86400_000);
      setFrom(d.toISOString().slice(0, 10));
      setTo(todayStr);
    } else if (preset === 'this_fy') {
      const fyStartY = m >= 4 ? y : y - 1;
      setFrom(`${fyStartY}-04-01`);
      setTo(todayStr);
    }
  }

  const csvUrl = `/api/finance/reports?report=${encodeURIComponent(report)}&format=csv${
    activeTab.usesDates ? `&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` : ''
  }`;

  const summary = data?.summary || {};
  const rows: any[] = data?.rows || [];

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-orange-600" /> Financial Reports &amp; Tax Exports
            </h2>
            <p className="text-xs text-slate-600 mt-0.5">{activeTab.desc}</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadReport}
              className="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
            <a
              href={csvUrl}
              download
              className="inline-flex items-center px-3 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
            >
              <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
            </a>
          </div>
        </div>

        {/* Report Selector Pills */}
        <div className="flex flex-wrap gap-2">
          {REPORT_TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setReport(t.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border transition ${
                report === t.id
                  ? 'bg-orange-600 text-white border-orange-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-100'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Date Range Filter (for date-scoped reports) */}
        {activeTab.usesDates && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Calendar className="h-3.5 w-3.5 text-slate-600" />
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="px-2.5 py-1 text-xs border border-slate-300 rounded-md bg-white text-slate-900"
            />
            <span className="text-xs text-slate-600">to</span>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="px-2.5 py-1 text-xs border border-slate-300 rounded-md bg-white text-slate-900"
            />
            <div className="flex flex-wrap gap-1.5 ml-1">
              <button type="button" onClick={() => applyPreset('this_month')} className="px-2 py-1 text-[11px] font-semibold rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100">This Month</button>
              <button type="button" onClick={() => applyPreset('last_month')} className="px-2 py-1 text-[11px] font-semibold rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100">Last Month</button>
              <button type="button" onClick={() => applyPreset('last_30')} className="px-2 py-1 text-[11px] font-semibold rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100">Last 30d</button>
              <button type="button" onClick={() => applyPreset('this_fy')} className="px-2 py-1 text-[11px] font-semibold rounded border border-slate-300 bg-white text-slate-700 hover:bg-slate-100">This FY</button>
            </div>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="p-4 space-y-4">
        {error && (
          <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-lg font-medium flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" /> {error}
          </div>
        )}

        {loading ? (
          <div className="py-10 text-center text-sm text-slate-600">Generating report...</div>
        ) : !data ? null : (
          <>
            {/* Summary Cards per Report */}
            {report === 'pnl' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Completed Rides</div>
                  <div className="text-lg font-bold font-mono text-slate-900 mt-0.5">{summary.rides_count ?? 0}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Gross Booking Value</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr(summary.gmv)}</div>
                </div>
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <div className="text-amber-900 font-semibold">GST Liability</div>
                  <div className="text-base font-bold font-mono text-amber-900 mt-0.5">{fmtInr(summary.total_gst_liability)}</div>
                </div>
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <div className="text-blue-900 font-semibold">Comm. + Tech Fee</div>
                  <div className="text-base font-bold font-mono text-blue-900 mt-0.5">{fmtInr((summary.commission_revenue || 0) + (summary.tech_fee_revenue || 0))}</div>
                </div>
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200">
                  <div className="text-rose-900 font-semibold">Incentives Paid</div>
                  <div className="text-base font-bold font-mono text-rose-900 mt-0.5">{fmtInr(summary.incentives_paid)}</div>
                </div>
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div className="text-emerald-900 font-semibold">Net Platform Revenue</div>
                  <div className="text-base font-bold font-mono text-emerald-800 mt-0.5">{fmtInr(summary.net_platform_revenue)}</div>
                </div>
              </div>
            )}

            {report === 'gstr1' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Invoices (B2B / B2C)</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">
                    {summary.invoice_count ?? 0} <span className="text-xs font-normal text-slate-600">({summary.b2b_count ?? 0}/{summary.b2c_count ?? 0})</span>
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Taxable Value</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr(summary.taxable_value)}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">CGST + SGST</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr((summary.cgst_amount || 0) + (summary.sgst_amount || 0))}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">IGST</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr(summary.igst_amount)}</div>
                </div>
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div className="text-emerald-900 font-semibold">Invoice Total</div>
                  <div className="text-base font-bold font-mono text-emerald-800 mt-0.5">{fmtInr(summary.invoice_total)}</div>
                </div>
                <div className={`p-3 rounded-lg border ${summary.pending_pos_count > 0 ? 'bg-rose-50 border-rose-200' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="text-slate-700 font-semibold">Pending PoS</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{summary.pending_pos_count ?? 0}</div>
                </div>
              </div>
            )}

            {report === 'dues_aging' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200">
                  <div className="text-rose-900 font-semibold">Total Dues Owed</div>
                  <div className="text-base font-bold font-mono text-rose-800 mt-0.5">{fmtInr(summary.total_owed)}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Drivers Owing / Over Limit</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">
                    {summary.drivers_owing_count ?? 0} / <span className="text-rose-700">{summary.over_limit_count ?? 0}</span>
                  </div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">0–7 Days</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr(summary.buckets?.['0-7d'])}</div>
                </div>
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <div className="text-amber-900 font-semibold">8–15 Days</div>
                  <div className="text-base font-bold font-mono text-amber-900 mt-0.5">{fmtInr(summary.buckets?.['8-15d'])}</div>
                </div>
                <div className="p-3 rounded-lg bg-orange-50 border border-orange-200">
                  <div className="text-orange-900 font-semibold">16–30 Days</div>
                  <div className="text-base font-bold font-mono text-orange-900 mt-0.5">{fmtInr(summary.buckets?.['16-30d'])}</div>
                </div>
                <div className="p-3 rounded-lg bg-rose-100 border border-rose-300">
                  <div className="text-rose-900 font-semibold">30+ Days</div>
                  <div className="text-base font-bold font-mono text-rose-900 mt-0.5">{fmtInr(summary.buckets?.['30+d'])}</div>
                </div>
              </div>
            )}

            {report === 'settlements' && (
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Drivers Active</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{summary.drivers_count ?? 0}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Completed Trips</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{summary.completed_trips ?? 0}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Driver Earnings</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr(summary.driver_earnings)}</div>
                </div>
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <div className="text-blue-900 font-semibold">Payouts Sent</div>
                  <div className="text-base font-bold font-mono text-blue-900 mt-0.5">{fmtInr(summary.payouts_sent)}</div>
                </div>
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div className="text-emerald-900 font-semibold">Payable to Drivers</div>
                  <div className="text-base font-bold font-mono text-emerald-800 mt-0.5">{fmtInr(summary.total_payable_to_drivers)}</div>
                </div>
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200">
                  <div className="text-rose-900 font-semibold">Receivable (Dues)</div>
                  <div className="text-base font-bold font-mono text-rose-800 mt-0.5">{fmtInr(summary.total_receivable_from_drivers)}</div>
                </div>
              </div>
            )}

            {report === 'reconciliation' && (
              <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200">
                  <div className="text-emerald-900 font-semibold">Paid Online</div>
                  <div className="text-base font-bold font-mono text-emerald-800 mt-0.5">{fmtInr(summary.paid_online_total)}</div>
                </div>
                <div className="p-3 rounded-lg bg-amber-50 border border-amber-200">
                  <div className="text-amber-900 font-semibold">Pending Links</div>
                  <div className="text-base font-bold font-mono text-amber-900 mt-0.5">{fmtInr(summary.pending_links_total)}</div>
                </div>
                <div className="p-3 rounded-lg bg-rose-50 border border-rose-200">
                  <div className="text-rose-900 font-semibold">Refunds Processed</div>
                  <div className="text-base font-bold font-mono text-rose-800 mt-0.5">{fmtInr(summary.refunds_processed_total)}</div>
                </div>
                <div className="p-3 rounded-lg bg-slate-50 border border-slate-200">
                  <div className="text-slate-600 font-semibold">Refunds Pending</div>
                  <div className="text-base font-bold font-mono text-slate-900 mt-0.5">{fmtInr(summary.refunds_pending_total)}</div>
                </div>
                <div className="p-3 rounded-lg bg-blue-50 border border-blue-200">
                  <div className="text-blue-900 font-semibold">Cancellation Charges</div>
                  <div className="text-base font-bold font-mono text-blue-900 mt-0.5">{fmtInr(summary.cancellation_charges_total)}</div>
                </div>
              </div>
            )}

            {/* Data Table */}
            {rows.length === 0 ? (
              <div className="py-8 text-center text-xs text-slate-600 bg-slate-50 rounded-lg border border-dashed border-slate-300 flex flex-col items-center gap-1.5">
                <FileSpreadsheet className="h-5 w-5 text-slate-500" />
                <span>No records found for the selected report and date range.</span>
              </div>
            ) : (
              <div className="overflow-x-auto border border-slate-200 rounded-lg">
                {report === 'pnl' && (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
                      <tr>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2 text-right">Rides</th>
                        <th className="px-3 py-2 text-right">GMV</th>
                        <th className="px-3 py-2 text-right">Ride GST</th>
                        <th className="px-3 py-2 text-right">Commission</th>
                        <th className="px-3 py-2 text-right">Tech Fee</th>
                        <th className="px-3 py-2 text-right">Driver Payout</th>
                        <th className="px-3 py-2 text-right">Cash</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 font-mono">
                      {rows.map((r) => (
                        <tr key={r.day} className="hover:bg-slate-50">
                          <td className="px-3 py-2 text-slate-900 font-semibold">{r.day}</td>
                          <td className="px-3 py-2 text-right text-slate-800">{r.rides_count}</td>
                          <td className="px-3 py-2 text-right text-slate-900">{fmtInr(r.gmv)}</td>
                          <td className="px-3 py-2 text-right text-amber-800">{fmtInr(r.ride_gst)}</td>
                          <td className="px-3 py-2 text-right text-emerald-700 font-semibold">{fmtInr(r.commission_revenue)}</td>
                          <td className="px-3 py-2 text-right text-blue-700">{fmtInr(r.tech_fee_revenue)}</td>
                          <td className="px-3 py-2 text-right text-slate-800">{fmtInr(r.driver_payout)}</td>
                          <td className="px-3 py-2 text-right text-slate-700">{fmtInr(r.cash_collected)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {report === 'gstr1' && (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
                      <tr>
                        <th className="px-3 py-2">Invoice #</th>
                        <th className="px-3 py-2">Date</th>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Customer</th>
                        <th className="px-3 py-2">PoS</th>
                        <th className="px-3 py-2 text-right">Taxable</th>
                        <th className="px-3 py-2 text-right">CGST</th>
                        <th className="px-3 py-2 text-right">SGST</th>
                        <th className="px-3 py-2 text-right">IGST</th>
                        <th className="px-3 py-2 text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 font-mono">
                      {rows.map((r) => (
                        <tr key={r.invoice_number} className="hover:bg-slate-50">
                          <td className="px-3 py-2 text-slate-900 font-semibold">{r.invoice_number}</td>
                          <td className="px-3 py-2 text-slate-700">{r.invoice_date}</td>
                          <td className="px-3 py-2"><span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 font-bold">{r.supply_type}</span></td>
                          <td className="px-3 py-2 font-sans text-slate-900">{r.customer_name}{r.customer_gstin ? ` (${r.customer_gstin})` : ''}</td>
                          <td className="px-3 py-2 text-slate-800">{r.place_of_supply_code}</td>
                          <td className="px-3 py-2 text-right">{fmtInr(r.taxable_value)}</td>
                          <td className="px-3 py-2 text-right">{fmtInr(r.cgst_amount)}</td>
                          <td className="px-3 py-2 text-right">{fmtInr(r.sgst_amount)}</td>
                          <td className="px-3 py-2 text-right">{fmtInr(r.igst_amount)}</td>
                          <td className="px-3 py-2 text-right font-semibold text-slate-900">{fmtInr(r.invoice_total)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {report === 'dues_aging' && (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
                      <tr>
                        <th className="px-3 py-2">Driver</th>
                        <th className="px-3 py-2">City</th>
                        <th className="px-3 py-2 text-right">Owed</th>
                        <th className="px-3 py-2 text-right">Limit</th>
                        <th className="px-3 py-2 text-right">Days</th>
                        <th className="px-3 py-2">Bucket</th>
                        <th className="px-3 py-2 text-right">Reserve</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {rows.map((r) => (
                        <tr key={r.driver_id} className="hover:bg-slate-50">
                          <td className="px-3 py-2">
                            <div className="font-semibold text-slate-900">{r.full_name}</div>
                            <div className="font-mono text-[11px] text-slate-600">{r.phone}</div>
                          </td>
                          <td className="px-3 py-2 text-slate-700">{r.base_city}</td>
                          <td className="px-3 py-2 text-right font-mono font-bold text-rose-700">{fmtInr(r.amount_owed)}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">{fmtInr(r.credit_limit)}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-800">{r.days_overdue}d</td>
                          <td className="px-3 py-2">
                            <span className={`px-2 py-0.5 rounded-full text-[11px] font-bold ${
                              r.aging_bucket === '30+d' ? 'bg-rose-100 text-rose-800'
                                : r.aging_bucket === '16-30d' ? 'bg-orange-100 text-orange-800'
                                  : r.aging_bucket === '8-15d' ? 'bg-amber-100 text-amber-900'
                                    : 'bg-slate-100 text-slate-800'
                            }`}>
                              {r.aging_bucket}
                            </span>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">{fmtInr(r.security_reserve_balance)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {report === 'settlements' && (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
                      <tr>
                        <th className="px-3 py-2">Driver</th>
                        <th className="px-3 py-2 text-right">Trips</th>
                        <th className="px-3 py-2 text-right">Earnings</th>
                        <th className="px-3 py-2 text-right">Comm.</th>
                        <th className="px-3 py-2 text-right">Payouts Sent</th>
                        <th className="px-3 py-2 text-right">Dues Paid</th>
                        <th className="px-3 py-2 text-right">Wallet Bal.</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {rows.map((r) => (
                        <tr key={r.driver_id} className="hover:bg-slate-50">
                          <td className="px-3 py-2">
                            <div className="font-semibold text-slate-900">{r.full_name}</div>
                            <div className="font-mono text-[11px] text-slate-600">{r.base_city} &bull; {r.phone}</div>
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-800">{r.completed_trips}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-900">{fmtInr(r.driver_earnings)}</td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">{fmtInr(r.commission_deducted)}</td>
                          <td className="px-3 py-2 text-right font-mono text-blue-700">{fmtInr(r.payouts_sent)}</td>
                          <td className="px-3 py-2 text-right font-mono text-emerald-700">{fmtInr(r.dues_collected)}</td>
                          <td className={`px-3 py-2 text-right font-mono font-bold ${
                            r.wallet_balance > 0 ? 'text-emerald-700' : r.wallet_balance < 0 ? 'text-rose-700' : 'text-slate-700'
                          }`}>
                            {fmtInr(r.wallet_balance)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {report === 'reconciliation' && (
                  <table className="min-w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
                      <tr>
                        <th className="px-3 py-2">Type</th>
                        <th className="px-3 py-2">Timestamp (IST)</th>
                        <th className="px-3 py-2">Booking</th>
                        <th className="px-3 py-2">Status</th>
                        <th className="px-3 py-2 text-right">Amount</th>
                        <th className="px-3 py-2">Provider Ref</th>
                        <th className="px-3 py-2">Voucher / Inv</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200 font-mono">
                      {rows.map((r, idx) => (
                        <tr key={`${r.record_type}-${idx}`} className="hover:bg-slate-50">
                          <td className="px-3 py-2 font-sans font-semibold text-slate-900">{r.record_type}</td>
                          <td className="px-3 py-2 text-slate-700">{r.created_ist}</td>
                          <td className="px-3 py-2 text-slate-900">{r.booking_code}</td>
                          <td className="px-3 py-2"><span className="px-1.5 py-0.5 rounded bg-slate-100 text-slate-800 font-bold">{r.status}</span></td>
                          <td className={`px-3 py-2 text-right font-semibold ${r.amount < 0 ? 'text-rose-700' : 'text-emerald-700'}`}>{fmtInr(r.amount)}</td>
                          <td className="px-3 py-2 text-slate-700">{r.provider_ref}</td>
                          <td className="px-3 py-2 text-slate-700">{r.voucher_or_invoice}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
