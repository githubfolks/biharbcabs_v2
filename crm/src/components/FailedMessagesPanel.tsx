'use client';

import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';

interface Failure {
  id: number;
  title: string;
  phone: string;
  bookingCode: string | null;
  error: string;
  createdAt: string;
}

const REFRESH_MS = 60_000;

/**
 * WhatsApp messages that did not reach the recipient. Staff follow each up by phone, then mark it
 * handled. Shown only while there is something to follow up (or the list could not be loaded).
 */
export default function FailedMessagesPanel({ canResolve }: { canResolve: boolean }) {
  const [failures, setFailures] = useState<Failure[]>([]);
  const [openCount, setOpenCount] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications/failures');
      const data = await res.json();
      if (!data.success) throw new Error(data.error || 'Could not load failed messages');
      setFailures(data.failures);
      setOpenCount(data.openCount);
      setLoadError(null);
    } catch (err: any) {
      setLoadError(err?.message || 'Could not load failed messages');
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  async function markHandled(id: number) {
    setBusyId(id);
    try {
      const res = await fetch(`/api/notifications/failures/${id}/resolve`, { method: 'POST' });
      const data = await res.json();
      // 409: someone else already marked it handled; either way it leaves the list.
      if (!data.success && res.status !== 409) alert(data.error || 'Could not mark the message handled');
      await load();
    } catch {
      alert('Could not mark the message handled: network error');
    } finally {
      setBusyId(null);
    }
  }

  if (loadError) {
    return (
      <div className="bg-white rounded-lg border border-rose-200 p-4 text-sm text-rose-700">
        Failed messages: {loadError}.{' '}
        <button onClick={load} className="underline font-medium">Retry</button>
      </div>
    );
  }
  if (openCount === 0) return null;

  return (
    <div className="bg-white rounded-lg border border-rose-200 shadow-sm overflow-hidden">
      <div className="px-4 py-3 bg-rose-50 flex items-center gap-2">
        <AlertTriangle className="h-4 w-4 text-rose-600" />
        <h2 className="text-sm font-semibold text-rose-800">
          Failed messages ({openCount}{openCount > failures.length ? `, newest ${failures.length} shown` : ''})
        </h2>
        <span className="text-xs text-rose-700 hidden md:inline">WhatsApp could not deliver these. Call the person, then mark handled.</span>
      </div>
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
            <tr>
              <th className="px-4 py-2">When</th>
              <th className="px-4 py-2">Message</th>
              <th className="px-4 py-2">To</th>
              <th className="px-4 py-2">Booking</th>
              <th className="px-4 py-2">Error</th>
              {canResolve && <th className="px-4 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {failures.map((f) => (
              <tr key={f.id}>
                <td className="px-4 py-2 whitespace-nowrap text-slate-600">
                  {new Date(f.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="px-4 py-2 text-slate-900">{f.title}</td>
                <td className="px-4 py-2 whitespace-nowrap"><a href={`tel:+${f.phone}`} className="text-blue-600 hover:underline">{f.phone}</a></td>
                <td className="px-4 py-2 whitespace-nowrap font-mono text-xs">{f.bookingCode ? `#${f.bookingCode}` : '—'}</td>
                <td className="px-4 py-2 text-xs text-slate-500 max-w-xs break-words">{f.error}</td>
                {canResolve && (
                  <td className="px-4 py-2 text-right">
                    <button
                      onClick={() => markHandled(f.id)}
                      disabled={busyId === f.id}
                      className="px-3 py-1 text-xs font-medium rounded-md border border-slate-300 text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                    >
                      {busyId === f.id ? 'Saving…' : 'Mark handled'}
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
