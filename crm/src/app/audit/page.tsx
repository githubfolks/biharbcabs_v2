'use client';

import { useState, useEffect, useCallback } from 'react';
import { ClipboardList, RefreshCw, Search, ChevronDown, ChevronRight } from 'lucide-react';

interface AuditRow {
  id: number;
  actor_id: number | null;
  actor_email: string | null;
  actor_name: string | null;
  actor_role: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  summary: string;
  before_data: unknown;
  after_data: unknown;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

function fmtIst(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function actionBadge(action: string): string {
  if (action.includes('FAIL') || action.includes('LOCK') || action.includes('CANCEL')) {
    return 'bg-rose-100 text-rose-800 border-rose-200';
  }
  if (action.includes('RESET') || action.includes('REVOKED') || action.includes('SETTINGS')) {
    return 'bg-amber-100 text-amber-900 border-amber-200';
  }
  if (action.includes('CREATED') || action.includes('LOGIN')) {
    return 'bg-emerald-100 text-emerald-800 border-emerald-200';
  }
  return 'bg-slate-100 text-slate-800 border-slate-200';
}

export default function AuditLogPage() {
  const [logs, setLogs] = useState<AuditRow[]>([]);
  const [actions, setActions] = useState<string[]>([]);
  const [entityTypes, setEntityTypes] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filterAction, setFilterAction] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ limit: '150' });
      if (filterAction) sp.set('action', filterAction);
      if (filterEntity) sp.set('entity_type', filterEntity);
      if (search.trim()) sp.set('q', search.trim());
      const res = await fetch(`/api/audit?${sp.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load audit logs');
      } else {
        setLogs(data.logs || []);
        setActions(data.facets?.actions || []);
        setEntityTypes(data.facets?.entity_types || []);
      }
    } catch {
      setError('Network error while loading audit logs');
    } finally {
      setLoading(false);
    }
  }, [filterAction, filterEntity, search]);

  useEffect(() => {
    const t = setTimeout(loadLogs, 200);
    return () => clearTimeout(t);
  }, [loadLogs]);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <ClipboardList className="h-6 w-6 text-orange-600" /> System Audit Log
          </h1>
          <p className="text-sm text-slate-600">
            Immutable trail of staff sign-ins, user/role updates, settings changes, bookings, cancellations, and payouts.
          </p>
        </div>
        <button
          type="button"
          onClick={loadLogs}
          className="inline-flex items-center px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="md:col-span-2 relative">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search summary, staff email, entity ID, or IP..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-500"
          />
        </div>
        <select
          value={filterEntity}
          onChange={(e) => setFilterEntity(e.target.value)}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900"
        >
          <option value="">All Entity Types</option>
          {entityTypes.map((et) => (
            <option key={et} value={et}>
              {et}
            </option>
          ))}
        </select>
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900"
        >
          <option value="">All Actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg">{error}</div>
      )}

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-600 font-semibold">
              <tr>
                <th className="px-3 py-3 w-8"></th>
                <th className="px-3 py-3">Timestamp (IST)</th>
                <th className="px-3 py-3">Actor</th>
                <th className="px-3 py-3">Action</th>
                <th className="px-3 py-3">Entity</th>
                <th className="px-3 py-3">Summary</th>
                <th className="px-3 py-3">IP</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-600 text-sm">
                    Loading audit trail...
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-600 text-sm">
                    No audit events match the selected filters.
                  </td>
                </tr>
              ) : (
                logs.map((row) => {
                  const hasPayload = row.before_data !== null || row.after_data !== null;
                  const open = expandedId === row.id;
                  return (
                    <>
                      <tr
                        key={row.id}
                        onClick={() => hasPayload && setExpandedId(open ? null : row.id)}
                        className={hasPayload ? 'cursor-pointer hover:bg-slate-50' : ''}
                      >
                        <td className="px-3 py-2.5 text-slate-600">
                          {hasPayload &&
                            (open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />)}
                        </td>
                        <td className="px-3 py-2.5 text-xs font-mono text-slate-700 whitespace-nowrap">
                          {fmtIst(row.created_at)}
                        </td>
                        <td className="px-3 py-2.5">
                          <div className="text-xs font-semibold text-slate-900">
                            {row.actor_name || row.actor_email || 'System'}
                          </div>
                          {row.actor_role && (
                            <div className="text-[10px] font-mono text-slate-600">{row.actor_role}</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span
                            className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold border ${actionBadge(
                              row.action
                            )}`}
                          >
                            {row.action}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-xs font-mono text-slate-800 whitespace-nowrap">
                          {row.entity_type}
                          {row.entity_id ? ` #${row.entity_id}` : ''}
                        </td>
                        <td className="px-3 py-2.5 text-xs text-slate-800">{row.summary}</td>
                        <td className="px-3 py-2.5 text-xs font-mono text-slate-600 whitespace-nowrap">
                          {row.ip_address || '—'}
                        </td>
                      </tr>
                      {open && hasPayload && (
                        <tr key={`${row.id}-diff`} className="bg-slate-50">
                          <td colSpan={7} className="px-6 py-3">
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
                              {row.before_data !== null && (
                                <div>
                                  <div className="font-bold text-slate-700 mb-1">Before</div>
                                  <pre className="p-2.5 rounded-lg bg-white border border-slate-200 overflow-x-auto font-mono text-[11px] text-slate-800">
                                    {JSON.stringify(row.before_data, null, 2)}
                                  </pre>
                                </div>
                              )}
                              {row.after_data !== null && (
                                <div>
                                  <div className="font-bold text-slate-700 mb-1">After</div>
                                  <pre className="p-2.5 rounded-lg bg-white border border-slate-200 overflow-x-auto font-mono text-[11px] text-slate-800">
                                    {JSON.stringify(row.after_data, null, 2)}
                                  </pre>
                                </div>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
