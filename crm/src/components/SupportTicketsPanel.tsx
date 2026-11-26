'use client';

import { useState, useEffect, useCallback } from 'react';
import { LifeBuoy, CheckCircle2, Clock, AlertTriangle, ChevronDown, ChevronRight } from 'lucide-react';

interface TicketRow {
  id: number;
  booking_code: string | null;
  origin_city: string | null;
  destination_city: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  driver_name: string | null;
  source: 'LOW_RATING' | 'SOS' | 'MANUAL';
  priority: 'NORMAL' | 'HIGH' | 'CRITICAL';
  status: 'OPEN' | 'IN_PROGRESS' | 'RESOLVED';
  rating: number | null;
  category: string | null;
  summary: string;
  resolution_notes: string | null;
  created_at: string;
}

export default function SupportTicketsPanel() {
  const [tickets, setTickets] = useState<TicketRow[]>([]);
  const [summary, setSummary] = useState({ open_count: 0, in_progress_count: 0, resolved_count: 0 });
  const [expanded, setExpanded] = useState(false);
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadTickets = useCallback(async () => {
    try {
      const res = await fetch('/api/support-tickets?limit=30', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        setTickets(data.tickets || []);
        if (data.summary) setSummary(data.summary);
      }
    } catch {
      // ignore background poll error
    }
  }, []);

  useEffect(() => {
    loadTickets();
  }, [loadTickets]);

  const activeCount = summary.open_count + summary.in_progress_count;
  if (activeCount === 0 && tickets.length === 0) return null;

  async function updateStatus(t: TicketRow, status: 'IN_PROGRESS' | 'RESOLVED') {
    let resolutionNotes: string | undefined;
    if (status === 'RESOLVED') {
      const note = window.prompt('Resolution / callback notes:', t.resolution_notes || 'Called customer and resolved issue');
      if (note === null) return;
      resolutionNotes = note;
    }
    setBusyId(t.id);
    try {
      await fetch(`/api/support-tickets/${t.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, resolution_notes: resolutionNotes }),
      });
      await loadTickets();
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className={`rounded-xl border shadow-sm overflow-hidden ${
      activeCount > 0 ? 'bg-rose-50 border-rose-300' : 'bg-white border-slate-200'
    }`}>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full px-4 py-3 flex flex-wrap items-center justify-between gap-2 text-left"
      >
        <div className="flex items-center gap-2.5">
          {activeCount > 0 ? (
            <AlertTriangle className="h-5 w-5 text-rose-600 shrink-0" />
          ) : (
            <LifeBuoy className="h-5 w-5 text-slate-600 shrink-0" />
          )}
          <div className="text-xs sm:text-sm font-bold text-slate-900">
            Customer Complaints &amp; SOS Queue: {summary.open_count} open, {summary.in_progress_count} in progress ({summary.resolved_count} resolved)
          </div>
        </div>
        <span className="inline-flex items-center text-xs font-semibold text-slate-700">
          {expanded ? 'Hide queue' : 'View queue'}
          {expanded ? <ChevronDown className="h-4 w-4 ml-1" /> : <ChevronRight className="h-4 w-4 ml-1" />}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-slate-200 bg-white divide-y divide-slate-200">
          {tickets.map((t) => (
            <div key={t.id} className="p-3.5 flex flex-wrap items-start justify-between gap-3 text-xs">
              <div className="space-y-1 min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono font-bold text-slate-900">#{t.id}</span>
                  <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                    t.priority === 'CRITICAL'
                      ? 'bg-rose-600 text-white'
                      : t.priority === 'HIGH'
                        ? 'bg-rose-100 text-rose-800'
                        : 'bg-amber-100 text-amber-900'
                  }`}>
                    {t.priority} &bull; {t.source}
                  </span>
                  {t.rating && (
                    <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-800">
                      {t.rating}★
                    </span>
                  )}
                  {t.booking_code && (
                    <span className="font-mono font-semibold text-slate-700">#{t.booking_code}</span>
                  )}
                </div>
                <div className="text-slate-900 font-medium">{t.summary}</div>
                <div className="text-[11px] text-slate-600">
                  Customer: {t.customer_name || '—'} ({t.customer_phone || '—'})
                  {t.driver_name ? ` • Driver: ${t.driver_name}` : ''}
                </div>
                {t.resolution_notes && (
                  <div className="text-[11px] text-emerald-700 font-medium">Resolution: {t.resolution_notes}</div>
                )}
              </div>

              <div className="flex items-center gap-1.5 shrink-0">
                {t.status === 'OPEN' && (
                  <button
                    type="button"
                    disabled={busyId === t.id}
                    onClick={() => updateStatus(t, 'IN_PROGRESS')}
                    className="inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-semibold bg-amber-100 text-amber-900 hover:bg-amber-200"
                  >
                    <Clock className="h-3 w-3 mr-1" /> In Progress
                  </button>
                )}
                {t.status !== 'RESOLVED' ? (
                  <button
                    type="button"
                    disabled={busyId === t.id}
                    onClick={() => updateStatus(t, 'RESOLVED')}
                    className="inline-flex items-center px-2.5 py-1 rounded-md text-[11px] font-semibold bg-emerald-600 text-white hover:bg-emerald-700"
                  >
                    <CheckCircle2 className="h-3 w-3 mr-1" /> Resolve
                  </button>
                ) : (
                  <span className="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800">
                    RESOLVED
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
