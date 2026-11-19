'use client';

import { useState, useEffect } from 'react';
import { 
  Car, Clock, AlertTriangle, CheckCircle, RefreshCw, Send, UserCheck, 
  PlusCircle, Phone, MapPin, DollarSign, Calendar
} from 'lucide-react';
import { hasPermission } from '@/lib/permissions';
import FailedMessagesPanel from '@/components/FailedMessagesPanel';
import { CANCELLABLE_STATUSES, MIN_WAIVER_REASON_LENGTH, WAIVABLE_STATUSES } from '@/lib/advance-rules';

export default function DispatchBoard() {
  const [bookings, setBookings] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<string>('ALL');
  const [showNewModal, setShowNewModal] = useState(false);
  const [actionLoading, setActionLoading] = useState<number | null>(null);

  // Advance waiver on bookings waiting for their advance (finance / super admin only; the API enforces it)
  const [role, setRole] = useState<string | null>(null);
  const [waiveBooking, setWaiveBooking] = useState<any | null>(null);
  const [waiveReason, setWaiveReason] = useState('');
  const [waiveError, setWaiveError] = useState<string | null>(null);
  const [waiving, setWaiving] = useState(false);
  const canWaive = hasPermission(role, 'bookings.waive_advance');
  const canCancel = hasPermission(role, 'bookings.cancel');
  const canOverrideFare = hasPermission(role, 'bookings.override_fare');

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

  async function handleWaive(e: React.FormEvent) {
    e.preventDefault();
    if (!waiveBooking) return;
    setWaiving(true);
    setWaiveError(null);
    try {
      const res = await fetch(`/api/bookings/${waiveBooking.id}/advance`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'waive', reason: waiveReason }),
      });
      const data = await res.json();
      if (data.success) {
        setWaiveBooking(null);
        alert(data.message);
        loadBookings();
      } else {
        setWaiveError(data.error || 'Advance not waived');
      }
    } catch {
      setWaiveError('Advance not waived: network error');
    } finally {
      setWaiving(false);
    }
  }

  // New Booking Form State
  const [newBooking, setNewBooking] = useState({
    customer_name: '',
    customer_phone: '',
    origin_city: 'Patna',
    destination_city: 'Darbhanga',
    pickup_address: 'Patna Junction / Airport',
    pickup_date: new Date().toISOString().split('T')[0],
    pickup_time: '10:00',
    trip_type: 'oneway',
    wp_vehicle_code: 'sedan',
    distance_km: 145,
    // Empty: the server uses the rate-card fare. A different fare needs the super admin and a reason.
    customer_total_fare: '' as string | number,
    fare_override_reason: '',
    auto_broadcast: true,
    advance_mode: 'PAYMENT_LINK',
    advance_waiver_reason: '',
  });

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

  async function handleCreateBooking(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newBooking),
      });
      const data = await res.json();
      if (data.success) {
        setShowNewModal(false);
        loadBookings();
      } else {
        alert(data.error || 'Failed to create booking');
      }
    } catch (err: any) {
      alert('Error creating booking: ' + err.message);
    }
  }

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
          <button
            onClick={() => setShowNewModal(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-orange-600 hover:bg-orange-700"
          >
            <PlusCircle className="h-4 w-4 mr-2" />
            New Ride Dispatch
          </button>
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
        {['ALL', 'AWAITING_ADVANCE', 'AWAITING_DRIVER', 'ESCALATED_NO_DRIVER', 'DRIVER_ASSIGNED', 'COMPLETED_SETTLED'].map((st) => (
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
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    No bookings found in this view. Click "New Ride Dispatch" to create one.
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
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        Advance: ₹{Number(b.advance_paid || 0)} &bull; Cash Due: ₹{Number(b.balance_cash_due_from_customer || (b.customer_total_fare - (b.advance_paid || 0)))}
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
                        <span className="text-xs text-slate-400 italic">Unassigned</span>
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
                      {b.booking_status === 'CONFIRMED_AWAITING_DRIVER' || b.booking_status === 'ESCALATED_NO_DRIVER' ? (
                        <button
                          onClick={() => handleBroadcast(b.id)}
                          disabled={actionLoading === b.id}
                          className="inline-flex items-center px-2.5 py-1.5 border border-transparent text-xs font-medium rounded text-white bg-orange-600 hover:bg-orange-700 disabled:opacity-50"
                        >
                          <Send className="h-3 w-3 mr-1" />
                          {actionLoading === b.id ? 'Broadcasting...' : 'Broadcast'}
                        </button>
                      ) : canWaive && WAIVABLE_STATUSES.includes(b.booking_status) ? (
                        <button
                          onClick={() => {
                            setWaiveBooking(b);
                            setWaiveReason('');
                            setWaiveError(null);
                          }}
                          className="inline-flex items-center px-2.5 py-1.5 border border-slate-300 text-xs font-medium rounded text-slate-700 bg-white hover:bg-slate-50"
                        >
                          Waive advance
                        </button>
                      ) : !(canCancel && CANCELLABLE_STATUSES.includes(b.booking_status)) ? (
                        <span className="text-xs text-slate-400">&mdash;</span>
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

      {/* Modal: Waive Advance */}
      {waiveBooking && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <form onSubmit={handleWaive} className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-3">
            <h3 className="text-base font-bold text-slate-900">Waive advance on #{waiveBooking.booking_code}</h3>
            <p className="text-xs text-slate-500">
              The payment link is cancelled, the customer pays the full fare of ₹
              {Number(waiveBooking.customer_total_fare).toLocaleString('en-IN')} in cash to the driver, and the ride goes to
              drivers now. BiharCabs&apos; share is then collected from the driver.
            </p>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Reason (recorded with your name)</label>
              <textarea
                required
                minLength={MIN_WAIVER_REASON_LENGTH}
                value={waiveReason}
                onChange={(e) => setWaiveReason(e.target.value)}
                placeholder="e.g. Customer has no UPI; regular customer, confirmed by phone"
                className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
              />
            </div>
            {waiveError && <div className="text-sm text-rose-600">{waiveError}</div>}
            <div className="flex justify-end space-x-2 pt-2 border-t">
              <button
                type="button"
                onClick={() => setWaiveBooking(null)}
                className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={waiving}
                className="px-4 py-2 rounded-md text-sm font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
              >
                {waiving ? 'Waiving…' : 'Waive and dispatch'}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Modal: New Ride Dispatch */}
      {showNewModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-900">New Ride Booking & Dispatch</h3>
              <button onClick={() => setShowNewModal(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button>
            </div>
            <form onSubmit={handleCreateBooking} className="space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Customer Name</label>
                  <input
                    type="text"
                    required
                    value={newBooking.customer_name}
                    onChange={(e) => setNewBooking({ ...newBooking, customer_name: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. Ramesh Kumar"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Customer Phone (WhatsApp)</label>
                  <input
                    type="text"
                    required
                    value={newBooking.customer_phone}
                    onChange={(e) => setNewBooking({ ...newBooking, customer_phone: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. 919876543210"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Origin City</label>
                  <input
                    type="text"
                    required
                    value={newBooking.origin_city}
                    onChange={(e) => setNewBooking({ ...newBooking, origin_city: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Destination City</label>
                  <input
                    type="text"
                    required
                    value={newBooking.destination_city}
                    onChange={(e) => setNewBooking({ ...newBooking, destination_city: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Pickup Landmark Address</label>
                <input
                  type="text"
                  required
                  value={newBooking.pickup_address}
                  onChange={(e) => setNewBooking({ ...newBooking, pickup_address: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Pickup Date</label>
                  <input
                    type="date"
                    required
                    value={newBooking.pickup_date}
                    onChange={(e) => setNewBooking({ ...newBooking, pickup_date: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Pickup Time</label>
                  <input
                    type="time"
                    required
                    value={newBooking.pickup_time}
                    onChange={(e) => setNewBooking({ ...newBooking, pickup_time: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Vehicle Category</label>
                  <select
                    value={newBooking.wp_vehicle_code}
                    onChange={(e) => setNewBooking({ ...newBooking, wp_vehicle_code: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  >
                    <option value="sedan">Sedan (Dzire/Etios)</option>
                    <option value="ertiga">Ertiga SUV (6+1)</option>
                    <option value="innova">Innova Crysta</option>
                    <option value="tempo">Tempo Traveller</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Fare (₹)</label>
                  <input
                    type="number"
                    min="1"
                    placeholder="Rate card"
                    disabled={!canOverrideFare}
                    value={newBooking.customer_total_fare}
                    onChange={(e) => setNewBooking({ ...newBooking, customer_total_fare: e.target.value === '' ? '' : Number(e.target.value) })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm disabled:bg-slate-50"
                  />
                  <p className="text-[10px] text-slate-500 mt-0.5">
                    {canOverrideFare ? 'Leave empty for the rate-card fare.' : 'Priced from the rate card. Only the super admin can set a different fare.'}
                  </p>
                  {canOverrideFare && newBooking.customer_total_fare !== '' && (
                    <input
                      minLength={10}
                      placeholder="Why a different fare? (recorded)"
                      value={newBooking.fare_override_reason}
                      onChange={(e) => setNewBooking({ ...newBooking, fare_override_reason: e.target.value })}
                      className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    />
                  )}
                </div>
                <div className="flex items-center pt-5">
                  <label className="flex items-center space-x-2 text-xs font-semibold text-slate-700 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newBooking.auto_broadcast}
                      onChange={(e) => setNewBooking({ ...newBooking, auto_broadcast: e.target.checked })}
                      className="rounded text-orange-600 focus:ring-orange-500"
                    />
                    <span>Broadcast ride to matching drivers immediately</span>
                  </label>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Customer Advance</label>
                <select
                  value={newBooking.advance_mode}
                  onChange={(e) => setNewBooking({ ...newBooking, advance_mode: e.target.value })}
                  className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                >
                  <option value="PAYMENT_LINK">Send Razorpay payment link (drivers see the ride after payment)</option>
                  <option value="FULL_CASH">Full cash to driver (only where advance is optional)</option>
                  <option value="WAIVED">Waive advance (reason required, logged)</option>
                </select>
                {newBooking.advance_mode === 'WAIVED' && (
                  <textarea
                    required
                    minLength={10}
                    placeholder="Why is the advance waived?"
                    value={newBooking.advance_waiver_reason}
                    onChange={(e) => setNewBooking({ ...newBooking, advance_waiver_reason: e.target.value })}
                    className="w-full mt-2 px-3 py-1.5 border rounded-md text-sm"
                  />
                )}
              </div>

              <div className="flex justify-end space-x-2 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowNewModal(false)}
                  className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-orange-600 text-white rounded-md text-sm font-medium hover:bg-orange-700"
                >
                  Create & Launch Dispatch
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

