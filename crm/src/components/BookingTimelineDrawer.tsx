'use client';

import { useEffect, useState, useCallback } from 'react';
import {
  X, Clock, CheckCircle2, AlertTriangle, Car, Radio, ShieldCheck,
  KeyRound, Bell, XCircle, MessageSquarePlus, MapPin, RefreshCw, UserCheck,
} from 'lucide-react';

interface TimelineEvent {
  id: number;
  event_type: string;
  from_status: string | null;
  to_status: string | null;
  actor_type: 'CUSTOMER' | 'DRIVER' | 'ADMIN' | 'SYSTEM';
  actor_id: number | null;
  actor_label: string | null;
  summary: string;
  metadata: Record<string, any>;
  created_at: string;
}

interface DispatchOffer {
  id: number;
  driver_id: number;
  driver_name: string | null;
  driver_phone: string | null;
  offer_status: string;
  sent_at: string;
  responded_at: string | null;
}

interface Props {
  bookingId: number;
  canManage: boolean;
  onClose: () => void;
  onUpdated?: () => void;
}

function formatIst(ts: string | null | undefined): string {
  if (!ts) return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
}

function eventVisual(eventType: string): { icon: any; bg: string; fg: string } {
  switch (eventType) {
    case 'BOOKING_CREATED':
      return { icon: Clock, bg: 'bg-slate-100', fg: 'text-slate-700' };
    case 'DRIVER_BROADCAST':
      return { icon: Radio, bg: 'bg-amber-100', fg: 'text-amber-700' };
    case 'DRIVER_ASSIGNED':
    case 'DRIVER_REASSIGNED':
      return { icon: UserCheck, bg: 'bg-blue-100', fg: 'text-blue-700' };
    case 'DRIVER_OFFER_DECLINED':
      return { icon: XCircle, bg: 'bg-slate-100', fg: 'text-slate-500' };
    case 'START_OTP_ISSUED':
      return { icon: KeyRound, bg: 'bg-indigo-100', fg: 'text-indigo-700' };
    case 'START_OTP_FAILED':
    case 'START_OTP_LOCKED':
      return { icon: AlertTriangle, bg: 'bg-rose-100', fg: 'text-rose-700' };
    case 'WAKEUP_SENT':
    case 'WAKEUP_CONFIRMED':
      return { icon: Bell, bg: 'bg-cyan-100', fg: 'text-cyan-700' };
    case 'WAKEUP_ALERTED':
    case 'SLA_ESCALATED':
      return { icon: AlertTriangle, bg: 'bg-rose-100', fg: 'text-rose-700' };
    case 'DRIVER_ARRIVED':
      return { icon: MapPin, bg: 'bg-teal-100', fg: 'text-teal-700' };
    case 'TRIP_STARTED':
      return { icon: Car, bg: 'bg-emerald-100', fg: 'text-emerald-700' };
    case 'TRIP_COMPLETED':
      return { icon: CheckCircle2, bg: 'bg-emerald-100', fg: 'text-emerald-800' };
    case 'CANCELLED':
      return { icon: XCircle, bg: 'bg-rose-100', fg: 'text-rose-700' };
    default:
      return { icon: ShieldCheck, bg: 'bg-purple-100', fg: 'text-purple-700' };
  }
}

function actorBadgeClass(actorType: string): string {
  switch (actorType) {
    case 'ADMIN':
      return 'bg-purple-100 text-purple-800';
    case 'DRIVER':
      return 'bg-blue-100 text-blue-800';
    case 'CUSTOMER':
      return 'bg-orange-100 text-orange-800';
    default:
      return 'bg-slate-100 text-slate-700';
  }
}

export default function BookingTimelineDrawer({ bookingId, canManage, onClose, onUpdated }: Props) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [booking, setBooking] = useState<any | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [offers, setOffers] = useState<DispatchOffer[]>([]);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const loadTimeline = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/timeline`);
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load ride timeline');
      } else {
        setBooking(data.booking);
        setEvents(data.events || []);
        setOffers(data.offers || []);
      }
    } catch {
      setError('Network error while loading ride timeline');
    } finally {
      setLoading(false);
    }
  }, [bookingId]);

  useEffect(() => {
    loadTimeline();
  }, [loadTimeline]);

  async function handleAction(action: 'mark_driver_arrived' | 'add_note') {
    if (action === 'add_note' && note.trim().length < 2) return;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch(`/api/bookings/${bookingId}/timeline`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, note: note.trim() }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Failed to update timeline');
      } else {
        setBooking(data.booking);
        setEvents(data.events || []);
        setOffers(data.offers || []);
        setNote('');
        onUpdated?.();
      }
    } catch {
      setError('Network error while saving timeline update');
    } finally {
      setSubmitting(false);
    }
  }

  const milestones = booking
    ? [
        { label: 'Created', at: booking.created_at },
        { label: 'Broadcast', at: booking.driver_broadcast_at },
        { label: 'Assigned', at: booking.driver_assigned_at || booking.start_otp_issued_at },
        { label: 'Arrived', at: booking.driver_arrived_at },
        { label: 'Started', at: booking.trip_started_at },
        booking.cancelled_at
          ? { label: 'Cancelled', at: booking.cancelled_at, danger: true }
          : { label: 'Completed', at: booking.trip_completed_at },
      ]
    : [];

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/50 backdrop-blur-xs">
      <div className="bg-white w-full max-w-xl h-full shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h2 className="text-lg font-bold text-slate-900">
              Ride Timeline {booking ? `#${booking.booking_code}` : ''}
            </h2>
            {booking && (
              <p className="text-xs text-slate-500 mt-0.5">
                {booking.origin_city} → {booking.destination_city || 'Local'} • {booking.customer_name || 'Customer'} ({booking.customer_phone})
              </p>
            )}
          </div>
          <div className="flex items-center space-x-2">
            <button
              type="button"
              onClick={loadTimeline}
              title="Refresh timeline"
              className="p-2 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={onClose}
              title="Close"
              className="p-2 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {/* Scrollable Body */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-5">
          {error && (
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-medium">
              {error}
            </div>
          )}

          {loading && !booking ? (
            <div className="py-12 text-center text-sm text-slate-600">Loading ride timeline…</div>
          ) : booking ? (
            <>
              {/* Milestone Strip */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 bg-slate-50 p-3 rounded-lg border border-slate-200">
                {milestones.map((m) => (
                  <div key={m.label} className="text-center">
                    <div
                      className={`text-[10px] font-bold uppercase tracking-wider ${
                        m.at
                          ? (m as any).danger
                            ? 'text-rose-700'
                            : 'text-emerald-700'
                          : 'text-slate-600'
                      }`}
                    >
                      {m.label}
                    </div>
                    <div className="text-[10px] text-slate-600 mt-0.5 truncate" title={formatIst(m.at)}>
                      {m.at
                        ? new Date(m.at).toLocaleTimeString('en-IN', {
                            timeZone: 'Asia/Kolkata',
                            hour: '2-digit',
                            minute: '2-digit',
                            hour12: true,
                          })
                        : 'Pending'}
                    </div>
                  </div>
                ))}
              </div>

              {/* Quick Dispatch Actions */}
              {canManage && (
                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                      Dispatch Actions
                    </span>
                    {booking.booking_status === 'DRIVER_ASSIGNED' && !booking.driver_arrived_at && (
                      <button
                        type="button"
                        disabled={submitting}
                        onClick={() => handleAction('mark_driver_arrived')}
                        className="inline-flex items-center px-2.5 py-1 rounded text-xs font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50"
                      >
                        <MapPin className="h-3.5 w-3.5 mr-1" />
                        Mark Driver Arrived
                      </button>
                    )}
                  </div>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Add an operational note to this ride timeline…"
                      className="flex-1 px-3 py-1.5 text-xs border border-slate-300 rounded-md bg-white text-slate-900"
                    />
                    <button
                      type="button"
                      disabled={submitting || note.trim().length < 2}
                      onClick={() => handleAction('add_note')}
                      className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-semibold bg-slate-800 text-white hover:bg-slate-900 disabled:opacity-40"
                    >
                      <MessageSquarePlus className="h-3.5 w-3.5 mr-1" />
                      Add Note
                    </button>
                  </div>
                </div>
              )}

              {/* Chronological Events */}
              <div>
                <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-3">
                  Event Log ({events.length})
                </h3>
                {events.length === 0 ? (
                  <div className="text-xs text-slate-600 italic py-4 text-center">
                    No timeline events recorded for this booking yet.
                  </div>
                ) : (
                  <ol className="relative border-l-2 border-slate-200 ml-3 space-y-4">
                    {events.map((ev) => {
                      const vis = eventVisual(ev.event_type);
                      const Icon = vis.icon;
                      return (
                        <li key={ev.id} className="ml-5">
                          <span
                            className={`absolute -left-3 flex items-center justify-center w-6 h-6 rounded-full ring-4 ring-white ${vis.bg} ${vis.fg}`}
                          >
                            <Icon className="h-3.5 w-3.5" />
                          </span>
                          <div className="bg-white border border-slate-200 rounded-lg p-3 shadow-2xs">
                            <div className="flex flex-wrap items-center justify-between gap-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-bold text-slate-900">
                                  {ev.event_type.replace(/_/g, ' ')}
                                </span>
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded uppercase ${actorBadgeClass(ev.actor_type)}`}>
                                  {ev.actor_type}
                                </span>
                                {ev.actor_label && (
                                  <span className="text-[11px] text-slate-500">{ev.actor_label}</span>
                                )}
                              </div>
                              <time className="text-[11px] text-slate-600 font-mono">
                                {formatIst(ev.created_at)}
                              </time>
                            </div>
                            <p className="text-xs text-slate-700 mt-1">{ev.summary}</p>
                            {(ev.from_status || ev.to_status) && (
                              <div className="text-[10px] text-slate-600 font-mono mt-1">
                                {ev.from_status ? `${ev.from_status} → ` : ''}
                                {ev.to_status || ''}
                              </div>
                            )}
                          </div>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </div>

              {/* Driver Broadcast Offers */}
              {offers.length > 0 && (
                <div>
                  <h3 className="text-xs font-bold uppercase tracking-wider text-slate-500 mb-2">
                    Driver Broadcast Offers ({offers.length})
                  </h3>
                  <div className="border border-slate-200 rounded-lg divide-y divide-slate-100 text-xs">
                    {offers.map((o) => (
                      <div key={o.id} className="px-3 py-2 flex items-center justify-between">
                        <div>
                          <span className="font-semibold text-slate-800">{o.driver_name || `Driver #${o.driver_id}`}</span>
                          {o.driver_phone && <span className="text-slate-600 ml-1.5">{o.driver_phone}</span>}
                          <div className="text-[10px] text-slate-600">
                            Sent: {formatIst(o.sent_at)}
                            {o.responded_at ? ` • Responded: ${formatIst(o.responded_at)}` : ''}
                          </div>
                        </div>
                        <span
                          className={`text-[10px] font-bold px-2 py-0.5 rounded uppercase ${
                            o.offer_status === 'ACCEPTED'
                              ? 'bg-emerald-100 text-emerald-800'
                              : o.offer_status === 'DECLINED'
                              ? 'bg-rose-100 text-rose-800'
                              : o.offer_status === 'PENDING'
                              ? 'bg-amber-100 text-amber-800'
                              : 'bg-slate-100 text-slate-600'
                          }`}
                        >
                          {o.offer_status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
