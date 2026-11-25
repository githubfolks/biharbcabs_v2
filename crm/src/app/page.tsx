'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { 
  Car, Clock, AlertTriangle, CheckCircle, RefreshCw, Send, UserCheck, 
  PlusCircle, Phone, MapPin, Calendar, History
} from 'lucide-react';
import { hasPermission } from '@/lib/permissions';
import FailedMessagesPanel from '@/components/FailedMessagesPanel';
import BookingTimelineDrawer from '@/components/BookingTimelineDrawer';
import { CANCELLABLE_STATUSES } from '@/lib/booking-rules';

export default function DispatchBoard() {
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  const [role, setRole] = useState<string | null>(null);
  const canCancel = hasPermission(role, 'bookings.cancel');
  const canManageDispatch = hasPermission(role, 'dispatch.manage');
  const [timelineBookingId, setTimelineBookingId] = useState<number | null>(null);

  // Cancelling a booking (staff): who is at fault decides the refund; the outcome is shown before confirming.
  const [cancelTarget, setCancelTarget] = useState<any | null>(null);
  const [cancelFault, setCancelFault] = useState<'CUSTOMER' | 'BIHARCABS'>('CUSTOMER');
  const [cancelReason, setCancelReason] = useState('');
  const [cancelPreview, setCancelPreview] = useState<string | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [cancelling, setCancelling] = useState(false);

  async function loadCancelPreview(b: any, fault: 'CUSTOMER' | 'BIHARCABS') {
    setCancelPreview(null);
    try {
      const res = await fetch(`/api/bookings/${b.id}/cancel?fault=${fault}`);
      const data = await res.json();
      if (data.success) setCancelPreview(data.decision.explanation);
      else setCancelError(data.error || 'Cannot cancel this booking');
    } catch {
      setCancelError('Could not load the refund outcome');
    }
  }

  function openCancel(b: any) {
    setCancelTarget(b);
    setCancelFault('CUSTOMER');
    setCancelReason('');
    setCancelError(null);
    loadCancelPreview(b, 'CUSTOMER');
  }

  async function handleCancel(e: React.FormEvent) {
    e.preventDefault();
    if (!cancelTarget) return;
    setCancelling(true);
    setCancelError(null);
    try {
      const res = await fetch(`/api/bookings/${cancelTarget.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fault: cancelFault, reason: cancelReason }),
      });
      const data = await res.json();
      if (data.success) {
        setCancelTarget(null);
        alert(`Booking #${data.bookingCode} cancelled. ${data.explanation}${data.refundStatus === 'FAILED' || data.refundStatus === 'MANUAL' ? ' The refund needs attention in Finance → Refunds.' : ''}`);
        loadBookings();
      } else {
        setCancelError(data.error || 'Booking not cancelled');
      }
    } catch {
      setCancelError('Booking not cancelled: network error');
    } finally {
      setCancelling(false);
    }
  }

  useEffect(() => {
    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => setRole(data?.user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  async function loadBookings() {
    setLoading(true);
    try {
      const url = statusFilter === 'ALL' ? '/api/bookings' : `/api/bookings?status=${statusFilter}`;
      const res = await fetch(url);
      const data = await res.json();
      if (data.success) {
        setBookings(data.bookings);
      }
    } catch (err) {
      console.error('Failed to load bookings:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBookings();
  }, [statusFilter]);

  async function handleBroadcast(bookingId: number) {
    setActionLoading(bookingId);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/dispatch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'broadcast' }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`Ride broadcasted to ${data.dispatch.offersCreated} matching verified drivers!`);
        loadBookings();
      } else {
        alert(data.error || 'Broadcast failed');
      }
    } catch (err: any) {
      alert('Error broadcasting ride: ' + err.message);
    } finally {
      setActionLoading(null);
    }
  }

  const awaitingCount = bookings.filter((b) => b.booking_status === 'AWAITING_DRIVER').length;
  const escalatedCount = bookings.filter((b) => b.booking_status === 'ESCALATED_NO_DRIVER').length;
  const activeCount = bookings.filter((b) => ['DRIVER_ASSIGNED', 'TRIP_IN_PROGRESS'].includes(b.booking_status)).length;
  const completedCount = bookings.filter((b) => ['COMPLETED_SETTLED', 'COMPLETED_UNBILLED'].includes(b.booking_status)).length;

  return (
    <div className="space-y-6">
      {/* Top Banner & Metrics */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Live Dispatch Operations</h1>
          <p className="text-sm text-slate-500">Automated WhatsApp broadcast, atomic first-accept locking, and SLA escalations</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => loadBookings()}
            className="inline-flex items-center px-3 py-2 border border-slate-300 shadow-sm text-sm font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <Link
            href="/bookings/new"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-orange-600 hover:bg-orange-700"
          >
            <PlusCircle className="h-4 w-4 mr-2" />
            New Booking &amp; Dispatch
          </Link>
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Awaiting Driver</span>
            <span className="p-2 bg-amber-50 text-amber-600 rounded-md"><Clock className="h-4 w-4" /></span>
          </div>
          <div className="text-2xl font-bold text-slate-900 mt-2">{awaitingCount}</div>
          <div className="text-xs text-amber-600 mt-1">Live broadcast active</div>
        </div>

        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Escalated SLAs</span>
            <span className="p-2 bg-rose-50 text-rose-600 rounded-md"><AlertTriangle className="h-4 w-4" /></span>
          </div>
          <div className="text-2xl font-bold text-rose-600 mt-2">{escalatedCount}</div>
          <div className="text-xs text-rose-600 mt-1">Requires admin manual assign</div>
        </div>

        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Active Rides</span>
            <span className="p-2 bg-blue-50 text-blue-600 rounded-md"><Car className="h-4 w-4" /></span>
          </div>
          <div className="text-2xl font-bold text-slate-900 mt-2">{activeCount}</div>
          <div className="text-xs text-blue-600 mt-1">Driver assigned / In-progress</div>
        </div>

        <div className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Completed & Settled</span>
            <span className="p-2 bg-emerald-50 text-emerald-600 rounded-md"><CheckCircle className="h-4 w-4" /></span>
          </div>
          <div className="text-2xl font-bold text-slate-900 mt-2">{completedCount}</div>
          <div className="text-xs text-emerald-600 mt-1">Invoiced & ledger reconciled</div>
        </div>
      </div>

      {role && hasPermission(role, 'bookings.view') && <FailedMessagesPanel canResolve={hasPermission(role, 'notifications.resolve')} />}

      {/* Filter Tabs */}
      <div className="border-b border-slate-200 flex space-x-2">
        {['ALL', 'AWAITING_DRIVER', 'ESCALATED_NO_DRIVER', 'DRIVER_ASSIGNED', 'COMPLETED_SETTLED'].map((st) => (
          <button
            key={st}
            onClick={() => setStatusFilter(st)}
            className={`py-2 px-4 text-xs font-semibold rounded-t-lg transition-colors border-b-2 ${
              statusFilter === st
                ? 'border-orange-600 text-orange-600 bg-white font-bold'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            {st.replace(/_/g, ' ')}
          </button>
        ))}
      </div>

      {/* Bookings Table */}
      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
              <tr>
                <th className="px-4 py-3">Booking ID</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3">Route & Schedule</th>
                <th className="px-4 py-3">Cab & Fare</th>
                <th className="px-4 py-3">Driver Assigned</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-slate-700">
              {bookings.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-600">
                    No bookings found in this view. Click &ldquo;New Booking &amp; Dispatch&rdquo; to create one.
                  </td>
                </tr>
              ) : (
                bookings.map((b) => (
                  <tr key={b.id} className="hover:bg-slate-50/60 transition">
                    <td className="px-4 py-3 font-mono font-bold text-slate-900">
                      #{b.booking_code}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{b.customer_name || 'Customer'}</div>
                      <div className="text-xs text-slate-500 flex items-center mt-0.5">
                        <Phone className="h-3 w-3 mr-1" />
                        {b.customer_phone}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900 flex items-center">
                        <MapPin className="h-3 w-3 mr-1 text-orange-600" />
                        {b.origin_city} → {b.destination_city || 'Local'}
                      </div>
                      <div className="text-xs text-slate-500 mt-0.5 flex items-center">
                        <Calendar className="h-3 w-3 mr-1" />
                        {new Date(b.pickup_date).toLocaleDateString('en-IN')} at {b.pickup_time}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">₹{Number(b.customer_total_fare).toLocaleString('en-IN')}</div>
                      <div className="text-xs text-slate-500 uppercase font-mono">
                        {b.wp_vehicle_code} &bull; Payout: ₹{Number(b.driver_payout_amount).toLocaleString('en-IN')}
                      </div>
                      <div className="text-[10px] text-slate-600 mt-0.5">
                        {b.package_name ? `${b.package_name} • ` : ''}Cash Payable at Drop: ₹{Number(b.customer_total_fare).toLocaleString('en-IN')}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      {b.driver_name ? (
                        <div>
                          <div className="font-medium text-emerald-700 flex items-center">
                            <UserCheck className="h-3 w-3 mr-1" />
                            {b.driver_name}
                          </div>
                          <div className="text-xs text-slate-500">{b.vehicle_model} ({b.vehicle_reg})</div>
                          {b.driver_status === 'RESTRICTED_DIGITAL_ONLY' && (
                            <span className="inline-flex items-center text-[10px] px-1.5 py-0.5 bg-indigo-100 text-indigo-800 rounded font-bold uppercase tracking-wider mt-0.5">
                              Digital Only Mode
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-xs text-slate-600 italic">Unassigned</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium uppercase ${
                        b.booking_status === 'AWAITING_DRIVER'
                          ? 'bg-amber-100 text-amber-800 animate-pulse'
                          : b.booking_status === 'ESCALATED_NO_DRIVER'
                          ? 'bg-rose-100 text-rose-800 font-bold'
                          : b.booking_status === 'DRIVER_ASSIGNED'
                          ? 'bg-blue-100 text-blue-800'
                          : b.booking_status === 'COMPLETED_SETTLED'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-slate-100 text-slate-800'
                      }`}>
                        {b.booking_status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      <button
                        onClick={() => setTimelineBookingId(Number(b.id))}
                        title="View ride timeline"
                        className="inline-flex items-center px-2.5 py-1.5 border border-slate-300 text-xs font-medium rounded text-slate-700 bg-white hover:bg-slate-50"
                      >
                        <History className="h-3.5 w-3.5 mr-1" />
                        Timeline
                      </button>
                      {b.booking_status === 'CONFIRMED_AWAITING_DRIVER' || b.booking_status === 'ESCALATED_NO_DRIVER' ? (
                        <button
                          onClick={() => handleBroadcast(b.id)}
                          disabled={actionLoading === b.id}
                          className="inline-flex items-center px-2.5 py-1.5 border border-transparent text-xs font-medium rounded text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50"
                        >
                          <Send className="h-3 w-3 mr-1" />
                          {actionLoading === b.id ? 'Broadcasting...' : 'Broadcast'}
                        </button>
                      ) : null}
                      {canCancel && CANCELLABLE_STATUSES.includes(b.booking_status) && (
                        <button
                          onClick={() => openCancel(b)}
                          className="inline-flex items-center px-2.5 py-1.5 border border-rose-200 text-xs font-medium rounded text-rose-700 bg-white hover:bg-rose-50"
                        >
                          Cancel
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Modal: Cancel Booking */}
      {cancelTarget && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleCancel} className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Cancel booking #{cancelTarget.booking_code}</h3>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Why is it cancelled?</label>
              <select
                value={cancelFault}
                onChange={(e) => {
                  const fault = e.target.value as 'CUSTOMER' | 'BIHARCABS';
                  setCancelFault(fault);
                  loadCancelPreview(cancelTarget, fault);
                }}
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              >
                <option value="CUSTOMER">Customer asked to cancel</option>
                <option value="BIHARCABS">BiharCabs cancelled (no driver, driver no-show, operational)</option>
              </select>
            </div>
            <p className="text-xs text-slate-600 bg-slate-50 rounded p-2">{cancelPreview || 'Working out the refund…'}</p>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Reason (recorded with your name)</label>
              <textarea
                required
                minLength={5}
                value={cancelReason}
                onChange={(e) => setCancelReason(e.target.value)}
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>
            {cancelError && <div className="text-sm text-rose-600">{cancelError}</div>}
            <div className="flex justify-end space-x-2 pt-2 border-t">
              <button type="button" onClick={() => setCancelTarget(null)} className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50">Keep booking</button>
              <button type="submit" disabled={cancelling} className="px-4 py-2 rounded-md text-sm font-semibold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50">
                {cancelling ? 'Cancelling…' : 'Cancel booking'}
              </button>
            </div>
          </form>
        </div>
      )}
      {timelineBookingId !== null && (
        <BookingTimelineDrawer
          bookingId={timelineBookingId}
          canManage={canManageDispatch}
          onClose={() => setTimelineBookingId(null)}
          onUpdated={loadBookings}
        />
      )}
    </div>
  );
}

