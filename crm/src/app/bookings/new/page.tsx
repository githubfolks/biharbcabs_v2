'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Car, Phone, Send, ArrowLeft, CheckCircle2, MapPin, Navigation, Loader2 } from 'lucide-react';
import Link from 'next/link';
import { BOOKING_TYPES } from '@/lib/booking-rules';

interface PlaceSuggestion {
  display_name: string;
  short_name: string;
  city: string;
  state: string;
  lat: number;
  lon: number;
}

interface DistanceInfo {
  distance_km: number;
  duration_minutes: number;
  duration_text: string;
  cached?: boolean;
}

interface AdjustedPricing {
  totalFairPreGst: number;
  gstPct: number;
  gstCharge: number;
  totalPayment: number;
  commissionPct: number;
  adminCommission: number;
  driverGrossEarnings: number;
  roadDistanceKm: number;
  billedKm: number;
  extraKm: number;
  extraKmChargePreGst: number;
}

function PlaceAutocompleteInput({
  label,
  required,
  value,
  placeholder,
  onChangeText,
  onSelectPlace,
}: {
  label: string;
  required?: boolean;
  value: string;
  placeholder: string;
  onChangeText: (val: string) => void;
  onSelectPlace: (place: PlaceSuggestion) => void;
}) {
  const [suggestions, setSuggestions] = useState<PlaceSuggestion[]>([]);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  function handleInput(val: string) {
    onChangeText(val);
    setNotice(null);
    if (timerRef.current) clearTimeout(timerRef.current);

    if (val.trim().length < 3) {
      setSuggestions([]);
      setOpen(false);
      setSearching(false);
      return;
    }

    const seq = ++seqRef.current;
    timerRef.current = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(`/api/location/autocomplete?q=${encodeURIComponent(val.trim())}`);
        const data = await res.json();
        if (seq !== seqRef.current) return;
        if (!data.success) {
          setNotice(data.error || 'Location search unavailable');
          setSuggestions([]);
          setOpen(false);
        } else {
          setSuggestions(data.suggestions || []);
          setOpen((data.suggestions || []).length > 0);
        }
      } catch {
        if (seq === seqRef.current) {
          setNotice('Location search unavailable — you can type manually.');
          setSuggestions([]);
          setOpen(false);
        }
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 350);
  }

  return (
    <div ref={containerRef} className="relative">
      <label className="block text-xs font-semibold text-slate-700">{label}</label>
      <div className="relative mt-1">
        <MapPin className="h-4 w-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
        <input
          required={required}
          value={value}
          autoComplete="off"
          onChange={(e) => handleInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setOpen(false);
          }}
          placeholder={placeholder}
          className="w-full pl-9 pr-8 py-2 border rounded-md text-sm"
        />
        {searching && <Loader2 className="h-4 w-4 text-orange-500 animate-spin absolute right-2.5 top-2.5" />}
      </div>
      {notice && <p className="text-[11px] text-amber-700 mt-1">{notice}</p>}
      {open && suggestions.length > 0 && (
        <ul className="absolute z-30 left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg max-h-60 overflow-y-auto divide-y divide-slate-100">
          {suggestions.map((s, idx) => (
            <li key={`${s.lat}-${s.lon}-${idx}`}>
              <button
                type="button"
                onClick={() => {
                  onSelectPlace(s);
                  setOpen(false);
                  setSuggestions([]);
                }}
                className="w-full text-left px-3 py-2 hover:bg-orange-50 transition"
              >
                <div className="text-sm font-semibold text-slate-900">{s.short_name}</div>
                <div className="text-xs text-slate-500 truncate">{s.display_name}</div>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default function OperatorNewBookingPage() {
  const router = useRouter();
  const [packages, setPackages] = useState<any[]>([]);
  const [initialLoading, setInitialLoading] = useState(true);
  const [refreshingAvailability, setRefreshingAvailability] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ bookingCode: string; offersCreated: number } | null>(null);

  const [bookingType, setBookingType] = useState<string>('OUTSTATION');
  const [selectedPackageId, setSelectedPackageId] = useState<string>('');

  const [sourceQuery, setSourceQuery] = useState('');
  const [destQuery, setDestQuery] = useState('');
  const [sourceCoords, setSourceCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [destCoords, setDestCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [distanceInfo, setDistanceInfo] = useState<DistanceInfo | null>(null);
  const [adjustedPricing, setAdjustedPricing] = useState<AdjustedPricing | null>(null);
  const [distanceLoading, setDistanceLoading] = useState(false);
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const lastManualRouteRef = useRef<{ origin: string; destination: string } | null>(null);

  const [form, setForm] = useState({
    customer_name: '',
    customer_phone: '',
    customer_email: '',
    origin_city: '',
    destination_city: '',
    pickup_address: '',
    drop_address: '',
    pickup_date: new Date().toISOString().split('T')[0],
    pickup_time: '10:00',
    special_notes: '',
    auto_broadcast: true,
  });

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setRefreshingAvailability(true);
      const sp = new URLSearchParams({ active: 'true' });
      if (form.origin_city.trim()) sp.set('origin_city', form.origin_city.trim());
      if (form.pickup_date) sp.set('pickup_date', form.pickup_date);
      if (form.pickup_time) sp.set('pickup_time', form.pickup_time);

      fetch(`/api/catalog/packages?${sp.toString()}`)
        .then((res) => res.json())
        .then((data) => {
          if (cancelled) return;
          if (data.success) {
            const list = data.packages || [];
            setPackages(list);
            // Deselect if the currently selected package became unavailable in the chosen city/time
            setSelectedPackageId((prev) => {
              if (!prev) return prev;
              const match = list.find((p: any) => String(p.id) === prev);
              if (match?.availability && !match.availability.is_available) return '';
              return prev;
            });
          } else {
            setError(data.error || 'Could not load packages');
          }
        })
        .catch(() => {
          if (!cancelled) setError('Could not load booking packages');
        })
        .finally(() => {
          if (!cancelled) {
            setInitialLoading(false);
            setRefreshingAvailability(false);
          }
        });
    }, 400);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [form.origin_city, form.pickup_date, form.pickup_time]);

  async function runDistanceQuery(params: URLSearchParams) {
    setDistanceLoading(true);
    setDistanceError(null);
    try {
      const res = await fetch(`/api/location/distance?${params.toString()}`);
      const data = await res.json();
      if (data.success && data.route) {
        setDistanceInfo(data.route);
        setAdjustedPricing(data.adjusted_pricing || null);
      } else {
        setDistanceInfo(null);
        setAdjustedPricing(null);
        setDistanceError(data.error || 'Could not calculate road distance');
      }
    } catch {
      setDistanceInfo(null);
      setAdjustedPricing(null);
      setDistanceError('Could not reach distance calculation service');
    } finally {
      setDistanceLoading(false);
    }
  }

  // Automatically calculate road distance & adjusted fare via LocationIQ when both Source & Destination coords are selected,
  // or refresh adjusted fare when the selected package changes.
  useEffect(() => {
    if (sourceCoords && destCoords) {
      lastManualRouteRef.current = null;
      const params = new URLSearchParams({
        from_lat: String(sourceCoords.lat),
        from_lon: String(sourceCoords.lon),
        to_lat: String(destCoords.lat),
        to_lon: String(destCoords.lon),
      });
      if (form.origin_city.trim()) params.set('origin', form.origin_city.trim());
      if (form.destination_city.trim()) params.set('destination', form.destination_city.trim());
      if (selectedPackageId) params.set('package_id', selectedPackageId);
      runDistanceQuery(params);
      return;
    }

    if (lastManualRouteRef.current && selectedPackageId) {
      const params = new URLSearchParams({
        origin: lastManualRouteRef.current.origin,
        destination: lastManualRouteRef.current.destination,
        package_id: selectedPackageId,
      });
      runDistanceQuery(params);
      return;
    }

    if (!lastManualRouteRef.current) {
      setDistanceInfo(null);
      setAdjustedPricing(null);
      setDistanceError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCoords, destCoords, selectedPackageId]);

  function handleCalculateManualDistance() {
    const origin = (form.origin_city || sourceQuery).trim();
    const destination = (form.destination_city || destQuery).trim();
    if (!origin || !destination) {
      setDistanceError('Enter both Origin City and Destination City to calculate distance.');
      return;
    }
    const params = new URLSearchParams();
    if (sourceCoords && destCoords) {
      params.set('from_lat', String(sourceCoords.lat));
      params.set('from_lon', String(sourceCoords.lon));
      params.set('to_lat', String(destCoords.lat));
      params.set('to_lon', String(destCoords.lon));
      params.set('origin', origin);
      params.set('destination', destination);
    } else {
      lastManualRouteRef.current = { origin, destination };
      params.set('origin', origin);
      params.set('destination', destination);
    }
    if (selectedPackageId) params.set('package_id', selectedPackageId);
    runDistanceQuery(params);
  }

  const filteredPackages = useMemo(
    () =>
      packages.filter(
        (p) =>
          p.booking_type === bookingType &&
          // Hide packages whose cab category has 0 free cabs in the chosen source city (e.g. on an ongoing ride)
          (!p.availability || p.availability.is_available)
      ),
    [packages, bookingType]
  );

  const selectedPkg = useMemo(
    () => filteredPackages.find((p) => String(p.id) === selectedPackageId) || null,
    [filteredPackages, selectedPackageId]
  );

  const estimatedExtraKm = useMemo(() => {
    if (!distanceInfo || !selectedPkg) return 0;
    const extra = distanceInfo.distance_km - Number(selectedPkg.included_km || 0);
    return extra > 0 ? Math.round(extra * 10) / 10 : 0;
  }, [distanceInfo, selectedPkg]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPkg) {
      setError('Please select a booking plan/package.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/bookings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          package_id: selectedPkg.id,
          distance_km: distanceInfo?.distance_km ?? selectedPkg.included_km,
          from_lat: sourceCoords?.lat ?? null,
          from_lon: sourceCoords?.lon ?? null,
          to_lat: destCoords?.lat ?? null,
          to_lon: destCoords?.lon ?? null,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Booking failed');
      } else {
        setCreated({
          bookingCode: data.booking.booking_code,
          offersCreated: data.dispatch?.offersCreated ?? 0,
        });
      }
    } catch (err: any) {
      setError(err?.message || 'Network error while creating booking');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="w-full space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="inline-flex items-center text-xs text-slate-500 hover:text-slate-800 mb-1">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Live Dispatch
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Operator Call / Enquiry Booking</h1>
          <p className="text-sm text-slate-500">Select a configured package, auto-fill source &amp; destination with live road distance, and trigger the WhatsApp dispatch workflow</p>
        </div>
      </div>

      {created && (
        <div className="p-4 bg-emerald-50 border border-emerald-200 rounded-lg flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <CheckCircle2 className="h-5 w-5 text-emerald-600" />
            <div>
              <div className="font-bold text-emerald-900">Booking #{created.bookingCode} Created &amp; WhatsApp Workflow Triggered</div>
              <div className="text-xs text-emerald-700">Customer notified on WhatsApp; ride broadcast to {created.offersCreated} eligible driver(s).</div>
            </div>
          </div>
          <button onClick={() => router.push('/')} className="px-3 py-1.5 bg-emerald-600 text-white text-xs font-semibold rounded-md">
            View on Dispatch Board
          </button>
        </div>
      )}

      {error && <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg">{error}</div>}

      <form onSubmit={handleSubmit} className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm space-y-6">
        {/* Step 1: Booking Type & Package Selection */}
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
              <Car className="h-4 w-4 mr-2 text-orange-600" /> 1. Select Booking Type &amp; Cab Package
            </h2>
            {refreshingAvailability && !initialLoading && (
              <span className="inline-flex items-center text-xs text-slate-500">
                <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin text-orange-500" /> Checking city availability...
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2">
            {BOOKING_TYPES.map((bt) => (
              <button
                type="button"
                key={bt}
                onClick={() => {
                  setBookingType(bt);
                  setSelectedPackageId('');
                }}
                className={`px-4 py-2 rounded-lg text-xs font-bold border transition ${
                  bookingType === bt
                    ? 'bg-orange-600 text-white border-orange-600'
                    : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                }`}
              >
                {bt === 'LOCAL' ? 'LOCAL (Airport / Railway Stn)' : bt}
              </button>
            ))}
          </div>

          {initialLoading ? (
            <div className="text-sm text-slate-500 py-4">Loading configured packages...</div>
          ) : filteredPackages.length === 0 ? (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              {form.origin_city.trim()
                ? `No free ${bookingType} cabs are currently available in ${form.origin_city.trim()} (all matching cabs may be on ongoing rides or none onboarded in this city).`
                : <>No active {bookingType} packages configured yet. Add them in <Link href="/catalog" className="underline font-semibold">Cabs, Fuel &amp; Plans</Link>.</>}
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredPackages.map((p) => {
                const active = String(p.id) === selectedPackageId;
                const avail = p.availability;
                const unavailable = Boolean(avail && !avail.is_available);
                return (
                  <button
                    type="button"
                    key={p.id}
                    disabled={unavailable}
                    onClick={() => !unavailable && setSelectedPackageId(String(p.id))}
                    className={`text-left p-3.5 rounded-lg border transition ${
                      unavailable
                        ? 'border-slate-200 bg-slate-50 opacity-60 cursor-not-allowed'
                        : active
                          ? 'border-orange-600 bg-orange-50/50 ring-2 ring-orange-200'
                          : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <div className="font-bold text-slate-900 text-sm">{p.name}</div>
                        <div className="text-xs text-slate-600">{p.cab_type.display_name}</div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-bold text-orange-700 font-mono">₹{p.pricing.totalPayment.toLocaleString('en-IN')}</div>
                        <div className="text-[10px] text-slate-500">incl. {p.pricing.gstPct}% GST</div>
                      </div>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-2 font-mono">
                      {p.included_km} km / {p.included_hours} hrs &bull; Extra: ₹{p.cab_type.extra_hour_charge}/hr, ₹{p.cab_type.extra_km_charge}/km
                    </div>
                    {avail ? (
                      <div className="mt-2">
                        {avail.is_available ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                            {avail.available_cabs} of {avail.total_cabs} {avail.category} available in {avail.city}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700">
                            Unavailable in {avail.city} (0 {avail.category} cabs free)
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mt-2 text-[10px] text-slate-400">Enter source city below to check live cab availability</div>
                    )}
                  </button>
                );
              })}
            </div>
          )}

          {selectedPkg && (() => {
            const livePricing = adjustedPricing ?? selectedPkg.pricing;
            const hasExtraKm = Boolean(adjustedPricing && adjustedPricing.extraKm > 0);
            return (
              <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs space-y-2.5">
                {hasExtraKm && adjustedPricing && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-md px-3 py-2 font-medium flex flex-wrap items-center justify-between gap-2">
                    <span>
                      Distance-adjusted fare: <strong>{adjustedPricing.roadDistanceKm} km</strong> road distance exceeds package {selectedPkg.included_km} km by <strong>{adjustedPricing.extraKm} km</strong>
                    </span>
                    <span className="font-mono font-bold">
                      +₹{adjustedPricing.extraKmChargePreGst.toFixed(2)} extra KM (pre-GST)
                    </span>
                  </div>
                )}
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3 font-mono">
                  <div><span className="text-slate-500 block">Total Fair (Pre-GST)</span><strong>₹{livePricing.totalFairPreGst.toFixed(2)}</strong></div>
                  <div><span className="text-slate-500 block">GST ({livePricing.gstPct}%)</span><strong>₹{livePricing.gstCharge.toFixed(2)}</strong></div>
                  <div><span className="text-slate-500 block">Total Payable</span><strong className="text-orange-700">₹{livePricing.totalPayment.toFixed(2)}</strong></div>
                  <div><span className="text-slate-500 block">Admin Comm. ({livePricing.commissionPct}%)</span><strong>₹{livePricing.adminCommission.toFixed(2)}</strong></div>
                  <div><span className="text-slate-500 block">Driver Payout</span><strong className="text-emerald-700">₹{livePricing.driverGrossEarnings.toFixed(2)}</strong></div>
                </div>
              </div>
            );
          })()}
        </div>

        {/* Step 2: Source, Destination & Live Distance */}
        <div className="space-y-3 border-t pt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
              <Navigation className="h-4 w-4 mr-2 text-orange-600" /> 2. Route (Source &amp; Destination Auto-Fill)
            </h2>
            <button
              type="button"
              onClick={handleCalculateManualDistance}
              disabled={distanceLoading || (!form.origin_city.trim() && !sourceQuery.trim()) || (!form.destination_city.trim() && !destQuery.trim())}
              className="inline-flex items-center px-3 py-1.5 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 transition"
            >
              {distanceLoading ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Navigation className="h-3.5 w-3.5 mr-1.5" />}
              Calculate Distance
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PlaceAutocompleteInput
              label="Search Source / Pickup Location *"
              required
              value={sourceQuery}
              placeholder="Type 3+ letters (e.g. Patna Junction, Purnea, Gaya Airport)"
              onChangeText={(val) => {
                setSourceQuery(val);
                setSourceCoords(null);
                setForm((prev) => ({ ...prev, pickup_address: val }));
              }}
              onSelectPlace={(place) => {
                setSourceQuery(place.display_name);
                setSourceCoords({ lat: place.lat, lon: place.lon });
                setForm((prev) => ({
                  ...prev,
                  origin_city: place.city || place.short_name,
                  pickup_address: place.display_name,
                }));
              }}
            />

            <PlaceAutocompleteInput
              label="Search Destination / Drop Location"
              value={destQuery}
              placeholder="Type 3+ letters (e.g. Darbhanga, Siliguri, Ranchi)"
              onChangeText={(val) => {
                setDestQuery(val);
                setDestCoords(null);
                setForm((prev) => ({ ...prev, destination_city: val, drop_address: val }));
              }}
              onSelectPlace={(place) => {
                setDestQuery(place.display_name);
                setDestCoords({ lat: place.lat, lon: place.lon });
                setForm((prev) => ({
                  ...prev,
                  destination_city: place.city || place.short_name,
                  drop_address: place.display_name,
                }));
              }}
            />
          </div>

          {/* Live Road Distance Banner */}
          {(distanceLoading || distanceInfo || distanceError) && (
            <div className="p-3 rounded-lg border bg-blue-50/70 border-blue-200 flex flex-wrap items-center justify-between gap-3 text-xs">
              {distanceLoading ? (
                <span className="inline-flex items-center text-blue-700 font-medium">
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Calculating driving distance via LocationIQ...
                </span>
              ) : distanceError ? (
                <span className="text-amber-800">{distanceError}</span>
              ) : distanceInfo ? (
                <>
                  <div className="flex flex-wrap items-center gap-4 text-blue-900 font-mono">
                    <span><strong>Road Distance:</strong> {distanceInfo.distance_km} km</span>
                    <span><strong>Est. Drive Time:</strong> {distanceInfo.duration_text}</span>
                    {distanceInfo.cached && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">cached</span>}
                  </div>
                  {selectedPkg && estimatedExtraKm > 0 && (
                    <span className="text-amber-800 font-semibold">
                      Exceeds package {selectedPkg.included_km} km by {adjustedPricing?.extraKm ?? estimatedExtraKm} km
                      {adjustedPricing
                        ? ` → Adjusted Total Payable: ₹${adjustedPricing.totalPayment.toLocaleString('en-IN')}`
                        : ` (Extra ₹${selectedPkg.cab_type.extra_km_charge}/km)`}
                    </span>
                  )}
                </>
              ) : null}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Origin City (for Driver Dispatch) *</label>
              <input required value={form.origin_city} onChange={(e) => setForm({ ...form, origin_city: e.target.value })} placeholder="e.g. Patna" className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Destination City</label>
              <input value={form.destination_city} onChange={(e) => setForm({ ...form, destination_city: e.target.value })} placeholder="e.g. Darbhanga" className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Pickup Address / Landmark *</label>
              <input required value={form.pickup_address} onChange={(e) => setForm({ ...form, pickup_address: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Drop Address (optional)</label>
              <input value={form.drop_address} onChange={(e) => setForm({ ...form, drop_address: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
          </div>
        </div>

        {/* Step 3: Customer & Schedule Details */}
        <div className="space-y-3 border-t pt-5">
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <Phone className="h-4 w-4 mr-2 text-orange-600" /> 3. Customer &amp; Schedule Details
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Customer Name *</label>
              <input required value={form.customer_name} onChange={(e) => setForm({ ...form, customer_name: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">WhatsApp Phone *</label>
              <input required value={form.customer_phone} onChange={(e) => setForm({ ...form, customer_phone: e.target.value })} placeholder="919876543210" className="w-full mt-1 px-3 py-2 border rounded-md text-sm font-mono" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Email (optional)</label>
              <input type="email" value={form.customer_email} onChange={(e) => setForm({ ...form, customer_email: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Pickup Date *</label>
              <input type="date" required value={form.pickup_date} onChange={(e) => setForm({ ...form, pickup_date: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Pickup Time *</label>
              <input type="time" required value={form.pickup_time} onChange={(e) => setForm({ ...form, pickup_time: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-700">Special Notes (optional)</label>
              <textarea rows={2} value={form.special_notes} onChange={(e) => setForm({ ...form, special_notes: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div className="flex items-center pt-3">
              <label className="flex items-center space-x-2 text-xs font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.auto_broadcast} onChange={(e) => setForm({ ...form, auto_broadcast: e.target.checked })} className="rounded text-orange-600" />
                <span>Trigger WhatsApp driver broadcast immediately</span>
              </label>
            </div>
          </div>
        </div>

        <div className="flex justify-end pt-4 border-t">
          <button
            type="submit"
            disabled={submitting || !selectedPkg}
            className="inline-flex items-center px-5 py-2.5 bg-orange-600 text-white rounded-lg text-sm font-semibold hover:bg-orange-700 disabled:opacity-50"
          >
            <Send className="h-4 w-4 mr-2" />
            {submitting ? 'Booking & Sending WhatsApp...' : 'Confirm Booking & Trigger WhatsApp Workflow'}
          </button>
        </div>
      </form>
    </div>
  );
}
