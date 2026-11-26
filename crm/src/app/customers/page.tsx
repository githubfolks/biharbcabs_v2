'use client';

import { useState, useEffect, useCallback } from 'react';
import { UserCheck, Search, RefreshCw, Star, Ban, X, Save, History } from 'lucide-react';

interface CustomerRow {
  id: number;
  phone: string;
  full_name: string | null;
  email: string | null;
  gstin: string | null;
  company_name: string | null;
  tag: 'REGULAR' | 'VIP' | 'BLOCKED';
  notes: string | null;
  blocked_reason: string | null;
  total_bookings: number;
  completed_bookings: number;
  cancelled_bookings: number;
  lifetime_value: number;
  last_booking_at: string | null;
}

interface CustomerBooking {
  id: number;
  booking_code: string;
  trip_type: string;
  origin_city: string;
  destination_city: string | null;
  pickup_date: string;
  pickup_time: string;
  wp_vehicle_code: string;
  customer_total_fare: number;
  booking_status: string;
  driver_name: string | null;
}

function fmtInr(n: number | undefined | null): string {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtIst(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export default function CustomersPage() {
  const [customers, setCustomers] = useState<CustomerRow[]>([]);
  const [summary, setSummary] = useState({
    total_customers: 0,
    repeat_customers: 0,
    vip_customers: 0,
    blocked_customers: 0,
    total_ltv: 0,
  });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [tagFilter, setTagFilter] = useState('');

  // Selected customer detail drawer
  const [selected, setSelected] = useState<CustomerRow | null>(null);
  const [bookings, setBookings] = useState<CustomerBooking[]>([]);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveNotice, setSaveNotice] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    full_name: '',
    email: '',
    gstin: '',
    company_name: '',
    tag: 'REGULAR' as 'REGULAR' | 'VIP' | 'BLOCKED',
    blocked_reason: '',
    notes: '',
  });

  const loadCustomers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const sp = new URLSearchParams({ limit: '150' });
      if (search.trim()) sp.set('q', search.trim());
      if (tagFilter) sp.set('tag', tagFilter);
      const res = await fetch(`/api/customers?${sp.toString()}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load customers');
      } else {
        setCustomers(data.customers || []);
        if (data.summary) setSummary(data.summary);
      }
    } catch {
      setError('Network error while loading customers');
    } finally {
      setLoading(false);
    }
  }, [search, tagFilter]);

  useEffect(() => {
    const t = setTimeout(loadCustomers, 200);
    return () => clearTimeout(t);
  }, [loadCustomers]);

  async function openCustomer(c: CustomerRow) {
    setSelected(c);
    setSaveNotice(null);
    setEditForm({
      full_name: c.full_name || '',
      email: c.email || '',
      gstin: c.gstin || '',
      company_name: c.company_name || '',
      tag: c.tag || 'REGULAR',
      blocked_reason: c.blocked_reason || '',
      notes: c.notes || '',
    });
    setLoadingDetail(true);
    try {
      const res = await fetch(`/api/customers/${c.id}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.success) {
        setBookings(data.bookings || []);
      }
    } finally {
      setLoadingDetail(false);
    }
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    setSaving(true);
    setSaveNotice(null);
    try {
      const res = await fetch(`/api/customers/${selected.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editForm),
      });
      const data = await res.json();
      if (data.success) {
        setSaveNotice('Customer profile updated.');
        setSelected({ ...selected, ...data.customer });
        await loadCustomers();
      } else {
        setSaveNotice(data.error || 'Update failed');
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <UserCheck className="h-6 w-6 text-orange-600" /> Customers CRM
          </h1>
          <p className="text-sm text-slate-600">
            Track repeat riders, lifetime value (LTV), corporate GSTINs, VIP tags, blocklist controls, and full booking history.
          </p>
        </div>
        <button
          type="button"
          onClick={loadCustomers}
          className="inline-flex items-center px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-slate-600 font-semibold">Total Customers</div>
          <div className="text-xl font-bold font-mono text-slate-900 mt-1">{summary.total_customers}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm">
          <div className="text-slate-600 font-semibold">Repeat Riders (2+)</div>
          <div className="text-xl font-bold font-mono text-blue-700 mt-1">{summary.repeat_customers}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-amber-200 shadow-sm">
          <div className="text-amber-900 font-semibold">VIP Customers</div>
          <div className="text-xl font-bold font-mono text-amber-800 mt-1">{summary.vip_customers}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-rose-200 shadow-sm">
          <div className="text-rose-900 font-semibold">Blocked</div>
          <div className="text-xl font-bold font-mono text-rose-700 mt-1">{summary.blocked_customers}</div>
        </div>
        <div className="bg-white p-4 rounded-xl border border-emerald-200 shadow-sm">
          <div className="text-emerald-900 font-semibold">Total Completed LTV</div>
          <div className="text-lg font-bold font-mono text-emerald-700 mt-1">{fmtInr(summary.total_ltv)}</div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white p-4 rounded-xl border border-slate-200 shadow-sm flex flex-wrap items-center gap-3">
        <div className="flex-1 min-w-[240px] relative">
          <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search name, phone, email, company, or GSTIN..."
            className="w-full pl-9 pr-3 py-2 text-sm border border-slate-300 rounded-lg text-slate-900 placeholder:text-slate-500"
          />
        </div>
        <div className="flex gap-1.5">
          {(['', 'VIP', 'REGULAR', 'BLOCKED'] as const).map((t) => (
            <button
              key={t || 'ALL'}
              type="button"
              onClick={() => setTagFilter(t)}
              className={`px-3 py-2 rounded-lg text-xs font-bold border transition ${
                tagFilter === t
                  ? 'bg-orange-600 text-white border-orange-600'
                  : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
              }`}
            >
              {t || 'All'}
            </button>
          ))}
        </div>
      </div>

      {error && <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg">{error}</div>}

      {/* Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-600 font-semibold">
              <tr>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Tag</th>
                <th className="px-4 py-3">Company / GSTIN</th>
                <th className="px-4 py-3 text-right">Rides (Done / Canc)</th>
                <th className="px-4 py-3 text-right">Lifetime Value</th>
                <th className="px-4 py-3">Last Booking</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-600 text-sm">Loading customers...</td>
                </tr>
              ) : customers.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-600 text-sm">No customers found.</td>
                </tr>
              ) : (
                customers.map((c) => (
                  <tr key={c.id} onClick={() => openCustomer(c)} className="cursor-pointer hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{c.full_name || 'Unnamed Customer'}</div>
                      <div className="text-xs font-mono text-slate-600">{c.phone}</div>
                      {c.email && <div className="text-[11px] text-slate-600">{c.email}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {c.tag === 'VIP' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-amber-100 text-amber-900">
                          <Star className="h-3 w-3 mr-1" /> VIP
                        </span>
                      ) : c.tag === 'BLOCKED' ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-bold bg-rose-100 text-rose-800">
                          <Ban className="h-3 w-3 mr-1" /> BLOCKED
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                          Regular
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">
                      <div>{c.company_name || '—'}</div>
                      {c.gstin && <div className="font-mono text-[11px] text-slate-600">{c.gstin}</div>}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs text-slate-800">
                      <strong>{c.total_bookings}</strong>{' '}
                      <span className="text-slate-600">({c.completed_bookings} / {c.cancelled_bookings})</span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-xs font-bold text-emerald-700">
                      {fmtInr(c.lifetime_value)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">{fmtIst(c.last_booking_at)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Customer Detail Drawer */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex justify-end">
          <div className="bg-white w-full max-w-xl h-full overflow-y-auto shadow-2xl p-6 space-y-5">
            <div className="flex items-start justify-between border-b pb-3">
              <div>
                <h2 className="text-lg font-bold text-slate-900">{selected.full_name || 'Customer Profile'}</h2>
                <div className="text-xs font-mono text-slate-600">{selected.phone}</div>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="p-1.5 text-slate-600 hover:text-slate-900">
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleSave} className="space-y-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Full Name</label>
                  <input value={editForm.full_name} onChange={(e) => setEditForm({ ...editForm, full_name: e.target.value })} className="w-full mt-1 px-3 py-1.5 border border-slate-300 rounded-md text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Email</label>
                  <input type="email" value={editForm.email} onChange={(e) => setEditForm({ ...editForm, email: e.target.value })} className="w-full mt-1 px-3 py-1.5 border border-slate-300 rounded-md text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Company Name</label>
                  <input value={editForm.company_name} onChange={(e) => setEditForm({ ...editForm, company_name: e.target.value })} className="w-full mt-1 px-3 py-1.5 border border-slate-300 rounded-md text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Customer GSTIN (for B2B)</label>
                  <input value={editForm.gstin} onChange={(e) => setEditForm({ ...editForm, gstin: e.target.value.toUpperCase() })} placeholder="10AAAAA0000A1Z5" className="w-full mt-1 px-3 py-1.5 border border-slate-300 rounded-md text-sm font-mono" />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Customer Tag</label>
                  <select
                    value={editForm.tag}
                    onChange={(e) => setEditForm({ ...editForm, tag: e.target.value as 'REGULAR' | 'VIP' | 'BLOCKED' })}
                    className="w-full mt-1 px-3 py-1.5 border border-slate-300 rounded-md text-sm bg-white"
                  >
                    <option value="REGULAR">Regular</option>
                    <option value="VIP">VIP</option>
                    <option value="BLOCKED">Blocked (Prevent Public Bookings)</option>
                  </select>
                </div>
                {editForm.tag === 'BLOCKED' && (
                  <div>
                    <label className="block text-xs font-semibold text-rose-700">Block Reason</label>
                    <input value={editForm.blocked_reason} onChange={(e) => setEditForm({ ...editForm, blocked_reason: e.target.value })} placeholder="e.g. Repeated no-shows" className="w-full mt-1 px-3 py-1.5 border border-rose-300 rounded-md text-sm" />
                  </div>
                )}
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Ops Notes</label>
                <textarea rows={2} value={editForm.notes} onChange={(e) => setEditForm({ ...editForm, notes: e.target.value })} className="w-full mt-1 px-3 py-1.5 border border-slate-300 rounded-md text-sm" />
              </div>

              {saveNotice && <div className="text-xs font-semibold text-emerald-700">{saveNotice}</div>}

              <div className="flex justify-end">
                <button type="submit" disabled={saving} className="inline-flex items-center px-4 py-2 bg-orange-600 text-white rounded-lg text-xs font-semibold hover:bg-orange-700 disabled:opacity-50">
                  <Save className="h-3.5 w-3.5 mr-1.5" /> {saving ? 'Saving...' : 'Save Customer Profile'}
                </button>
              </div>
            </form>

            {/* Ride History */}
            <div className="border-t pt-4 space-y-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-slate-700 flex items-center gap-1.5">
                <History className="h-4 w-4 text-orange-600" /> Recent Bookings ({bookings.length})
              </h3>
              {loadingDetail ? (
                <div className="text-xs text-slate-600 py-4">Loading booking history...</div>
              ) : bookings.length === 0 ? (
                <div className="text-xs text-slate-600 py-4">No bookings recorded for this customer yet.</div>
              ) : (
                <div className="space-y-2">
                  {bookings.map((b) => (
                    <div key={b.id} className="p-3 rounded-lg border border-slate-200 bg-slate-50/70 text-xs flex justify-between items-start gap-2">
                      <div>
                        <div className="font-bold text-slate-900 font-mono">#{b.booking_code} &bull; {b.trip_type}</div>
                        <div className="text-slate-700">{b.origin_city} → {b.destination_city || 'Local'}</div>
                        <div className="text-[11px] text-slate-600">{fmtIst(b.pickup_date)} {String(b.pickup_time).slice(0, 5)} {b.driver_name ? `• Driver: ${b.driver_name}` : ''}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-mono font-bold text-slate-900">{fmtInr(b.customer_total_fare)}</div>
                        <span className="inline-block mt-1 px-2 py-0.5 rounded bg-slate-200 text-slate-800 text-[10px] font-bold">{b.booking_status}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
