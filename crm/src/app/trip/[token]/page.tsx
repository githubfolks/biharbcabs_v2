'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, Car, MapPin, Phone, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';

interface PublicTrip {
  booking_code: string;
  trip_type: string;
  origin_city: string;
  destination_city: string | null;
  pickup_date: string;
  pickup_time: string;
  booking_status: string;
  driver_assigned_at: string | null;
  driver_arrived_at: string | null;
  trip_completed_at: string | null;
  sos_triggered_at: string | null;
  driver: {
    name: string;
    rating: number;
    kyc_verified: boolean;
    vehicle_model: string | null;
    vehicle_reg: string | null;
  } | null;
  support_phone: string | null;
  brand_name: string;
}

const STAGES = [
  { key: 'ASSIGNED', label: 'Driver Assigned' },
  { key: 'ARRIVED', label: 'Driver Arrived' },
  { key: 'STARTED', label: 'Trip In Progress' },
  { key: 'COMPLETED', label: 'Trip Completed' },
];

function currentStageIndex(trip: PublicTrip): number {
  if (trip.booking_status.startsWith('COMPLETED') || trip.trip_completed_at) return 3;
  if (trip.booking_status === 'TRIP_STARTED') return 2;
  if (trip.driver_arrived_at) return 1;
  if (trip.booking_status === 'DRIVER_ASSIGNED' || trip.driver_assigned_at) return 0;
  return -1;
}

export default function PublicTripTrackingPage({ params }: { params: { token: string } }) {
  const [trip, setTrip] = useState<PublicTrip | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [sosSending, setSosSending] = useState(false);
  const [sosNotice, setSosNotice] = useState<string | null>(null);

  const loadTrip = useCallback(async () => {
    try {
      const res = await fetch(`/api/public/trip/${encodeURIComponent(params.token)}`, { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load trip status.');
      } else {
        setTrip(data.trip);
        setError(null);
      }
    } catch {
      setError('Unable to reach BiharCabs trip service.');
    } finally {
      setLoading(false);
    }
  }, [params.token]);

  useEffect(() => {
    loadTrip();
    const timer = setInterval(loadTrip, 30_000);
    return () => clearInterval(timer);
  }, [loadTrip]);

  async function triggerSos() {
    if (!window.confirm('Send an urgent Safety SOS alert to BiharCabs Operations Desk?')) return;
    setSosSending(true);
    setSosNotice(null);
    try {
      const res = await fetch(`/api/public/trip/${encodeURIComponent(params.token)}/sos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note: 'Customer tapped SOS on live trip page' }),
      });
      const data = await res.json();
      setSosNotice(data.message || data.error || 'SOS processed.');
      await loadTrip();
    } finally {
      setSosSending(false);
    }
  }

  if (loading) {
    return <div className="min-h-screen flex items-center justify-center text-sm text-slate-600">Loading live trip status...</div>;
  }

  if (error || !trip) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4">
        <div className="max-w-md w-full bg-white rounded-xl border border-slate-200 shadow-sm p-6 text-center space-y-2">
          <AlertTriangle className="h-8 w-8 text-amber-600 mx-auto" />
          <h1 className="text-lg font-bold text-slate-900">Trip Link Unavailable</h1>
          <p className="text-sm text-slate-600">{error || 'This trip could not be found.'}</p>
        </div>
      </div>
    );
  }

  const stageIdx = currentStageIndex(trip);

  return (
    <div className="min-h-screen bg-slate-50 py-8 px-4">
      <div className="max-w-lg mx-auto space-y-5">
        {/* Brand Header */}
        <div className="bg-slate-900 text-white rounded-2xl p-5 shadow-md flex items-center justify-between">
          <div>
            <div className="text-lg font-black tracking-tight text-orange-400">{trip.brand_name}</div>
            <div className="text-xs text-slate-300 font-mono">Live Trip #{trip.booking_code}</div>
          </div>
          <span className="px-2.5 py-1 rounded-full text-[11px] font-bold bg-orange-600 text-white">
            {trip.booking_status.replace(/_/g, ' ')}
          </span>
        </div>

        {/* Route Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-3">
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
            <MapPin className="h-4 w-4 text-orange-600" /> {trip.trip_type} Route
          </div>
          <div className="text-lg font-bold text-slate-900">
            {trip.origin_city} → {trip.destination_city || 'Local'}
          </div>
          <div className="text-xs text-slate-700 font-mono flex items-center gap-2">
            <Clock className="h-3.5 w-3.5 text-slate-600" />
            Pickup: {String(trip.pickup_date).slice(0, 10)} at {trip.pickup_time} IST
          </div>

          {/* Progress Stepper */}
          <div className="grid grid-cols-4 gap-2 pt-3 border-t border-slate-100">
            {STAGES.map((st, i) => {
              const done = i <= stageIdx;
              return (
                <div key={st.key} className="text-center space-y-1">
                  <div className={`mx-auto w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold ${
                    done ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'
                  }`}>
                    {done ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  <div className={`text-[10px] font-semibold leading-tight ${done ? 'text-emerald-800' : 'text-slate-600'}`}>
                    {st.label}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Driver & Vehicle Card */}
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 space-y-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-slate-600">
              <Car className="h-4 w-4 text-orange-600" /> Assigned Chauffeur &amp; Vehicle
            </div>
            {trip.driver?.kyc_verified && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-bold bg-emerald-100 text-emerald-800">
                <ShieldCheck className="h-3.5 w-3.5 mr-1" /> KYC Verified
              </span>
            )}
          </div>
          {trip.driver ? (
            <div className="space-y-1 pt-1">
              <div className="text-base font-bold text-slate-900">
                {trip.driver.name} <span className="text-xs font-mono text-amber-700">★ {trip.driver.rating.toFixed(1)}</span>
              </div>
              {trip.driver.vehicle_model && (
                <div className="text-sm text-slate-700">
                  {trip.driver.vehicle_model} &bull; <span className="font-mono font-bold text-slate-900">{trip.driver.vehicle_reg}</span>
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-slate-600">Assigning your verified BiharCabs chauffeur shortly...</div>
          )}
        </div>

        {/* Safety & SOS Controls */}
        <div className="bg-white rounded-2xl border border-rose-200 shadow-sm p-5 space-y-3">
          <div className="text-xs font-bold uppercase tracking-wider text-rose-800 flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 text-rose-600" /> 24/7 Trip Safety &amp; Support
          </div>
          {sosNotice && (
            <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-800 text-xs font-semibold">
              {sosNotice}
            </div>
          )}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button
              type="button"
              disabled={sosSending}
              onClick={triggerSos}
              className="w-full py-3 px-4 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50"
            >
              {sosSending ? 'Alerting Operations...' : '🚨 SOS — Alert Operations'}
            </button>
            {trip.support_phone && (
              <a
                href={`tel:${trip.support_phone.replace(/[^+\d]/g, '')}`}
                className="w-full py-3 px-4 rounded-xl border border-slate-300 bg-slate-50 text-slate-900 text-sm font-bold flex items-center justify-center gap-2 hover:bg-slate-100"
              >
                <Phone className="h-4 w-4 text-emerald-700" /> Call Support
              </a>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
