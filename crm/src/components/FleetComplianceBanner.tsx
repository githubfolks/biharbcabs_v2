'use client';

import { useState, useEffect } from 'react';
import { AlertTriangle, ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';

interface ComplianceAlert {
  driver_id: number;
  full_name: string;
  phone: string;
  base_city: string;
  registration_no: string | null;
  document: string;
  expiry_date: string;
  severity: 'EXPIRED' | 'EXPIRING_SOON';
}

export default function FleetComplianceBanner() {
  const [alerts, setAlerts] = useState<ComplianceAlert[]>([]);
  const [summary, setSummary] = useState({ total_alerts: 0, expired_count: 0, expiring_soon_count: 0 });
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    fetch('/api/drivers/compliance?days=30', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d.success) {
          setAlerts(d.alerts || []);
          if (d.summary) setSummary(d.summary);
        }
      })
      .catch(() => {});
  }, []);

  if (summary.total_alerts === 0) return null;

  return (
    <div className={`rounded-xl border shadow-sm overflow-hidden ${
      summary.expired_count > 0 ? 'bg-rose-50 border-rose-300' : 'bg-amber-50 border-amber-300'
    }`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2.5">
          {summary.expired_count > 0 ? (
            <ShieldAlert className="h-5 w-5 text-rose-600 shrink-0" />
          ) : (
            <AlertTriangle className="h-5 w-5 text-amber-600 shrink-0" />
          )}
          <div className="text-xs sm:text-sm font-bold text-slate-900">
            Fleet Document Compliance Alert: {summary.expired_count} expired, {summary.expiring_soon_count} expiring within 30 days
          </div>
        </div>
        <span className="inline-flex items-center text-xs font-semibold text-slate-700">
          {expanded ? 'Hide details' : 'View details'}
          {expanded ? <ChevronDown className="h-4 w-4 ml-1" /> : <ChevronRight className="h-4 w-4 ml-1" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200/80 bg-white overflow-x-auto">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
              <tr>
                <th className="px-3 py-2">Driver</th>
                <th className="px-3 py-2">City</th>
                <th className="px-3 py-2">Vehicle</th>
                <th className="px-3 py-2">Document</th>
                <th className="px-3 py-2">Expiry Date</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {alerts.map((a, idx) => (
                <tr key={`${a.driver_id}-${a.document}-${idx}`}>
                  <td className="px-3 py-2 font-semibold text-slate-900">
                    {a.full_name} <span className="font-mono font-normal text-slate-600">({a.phone})</span>
                  </td>
                  <td className="px-3 py-2 text-slate-700">{a.base_city}</td>
                  <td className="px-3 py-2 font-mono text-slate-700">{a.registration_no || '—'}</td>
                  <td className="px-3 py-2 font-semibold text-slate-800">{a.document}</td>
                  <td className="px-3 py-2 font-mono text-slate-800">{a.expiry_date}</td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      a.severity === 'EXPIRED' ? 'bg-rose-100 text-rose-800' : 'bg-amber-100 text-amber-900'
                    }`}>
                      {a.severity === 'EXPIRED' ? 'EXPIRED' : 'EXPIRING SOON'}
                    </span>
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
