'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { Car, Phone, Send, ArrowLeft, CheckCircle2, MapPin, Navigation, Loader2, AlertTriangle, Search, X } from 'lucide-react';
import Link from 'next/link';
import { BOOKING_TYPES } from '@/lib/booking-rules';
import { getCabCategoryTheme } from '@/lib/cab-theme';

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
  techFeeAmount: number;
  totalPayment: number;
  commissionPct: number;
  adminCommission: number;
  driverGrossEarnings: number;
  roadDistanceKm: number;
  billedKm: number;
  extraKm: number;
  extraKmChargePreGst: number;
  isRoundTrip?: boolean;
  tripDays?: number;
  extraDays?: number;
  extraDayCabChargePreGst?: number;
  extraDayDriverTaPreGst?: number;
  tolerancePct?: number;
  maxAllowedKm?: number;
  withinPackageRange?: boolean;
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
        <MapPin className="h-4 w-4 text-slate-600 absolute left-3 top-2.5 pointer-events-none" />
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

function getLocalDateStr(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function getLocalTimeStr(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

export default function OperatorNewBookingPage() {
  const router = useRouter();
  const [now, setNow] = useState<Date>(() => new Date());
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
  const [serviceCoverage, setServiceCoverage] = useState<{ serviceable: boolean; reason: string | null } | null>(null);
  const [distanceLoading, setDistanceLoading] = useState(false);
  const [distanceError, setDistanceError] = useState<string | null>(null);
  const lastManualRouteRef = useRef<{ origin: string; destination: string } | null>(null);

  const [form, setForm] = useState(() => {
    const defaultPickup = new Date(Date.now() + 15 * 60_000);
    const defaultDate = getLocalDateStr(defaultPickup);
    return {
      customer_name: '',
      customer_phone: '',
      customer_email: '',
      origin_city: '',
      destination_city: '',
      pickup_address: '',
      drop_address: '',
      pickup_date: defaultDate,
      pickup_time: getLocalTimeStr(defaultPickup),
      is_round_trip: false,
      return_date: defaultDate,
      special_notes: '',
      auto_broadcast: true,
    };
  });

  // Keep current date/time fresh every 30s so min date/time constraints stay accurate while the page stays open.
  useEffect(() => {
    const interval = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(interval);
  }, []);

  const todayDateStr = getLocalDateStr(now);
  const currentTimeStr = getLocalTimeStr(now);

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      setRefreshingAvailability(true);
      const sp = new URLSearchParams({ active: 'true' });
      if (form.origin_city.trim()) sp.set('origin_city', form.origin_city.trim());
      if (form.pickup_date) sp.set('pickup_date', form.pickup_date);
      if (form.pickup_time) sp.set('pickup_time', form.pickup_time);
      if (form.is_round_trip) {
        sp.set('is_round_trip', 'true');
        if (form.return_date) sp.set('return_date', form.return_date);
      }

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
  }, [form.origin_city, form.pickup_date, form.pickup_time, form.is_round_trip, form.return_date]);

  async function runDistanceQuery(params: URLSearchParams) {
    setDistanceLoading(true);
    setDistanceError(null);
    try {
      const res = await fetch(`/api/location/distance?${params.toString()}`);
      const data = await res.json();
      if (data.success && data.route) {
        setDistanceInfo(data.route);
        setAdjustedPricing(data.adjusted_pricing || null);
        setServiceCoverage(data.service_coverage || null);
      } else {
        setDistanceInfo(null);
        setAdjustedPricing(null);
        setServiceCoverage(null);
        setDistanceError(data.error || 'Could not calculate road distance');
      }
    } catch {
      setDistanceInfo(null);
      setAdjustedPricing(null);
      setServiceCoverage(null);
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
      if (form.is_round_trip) {
        params.set('is_round_trip', 'true');
        if (form.pickup_date) params.set('pickup_date', form.pickup_date);
        if (form.return_date) params.set('return_date', form.return_date);
      }
      runDistanceQuery(params);
      return;
    }

    if (lastManualRouteRef.current && selectedPackageId) {
      const params = new URLSearchParams({
        origin: lastManualRouteRef.current.origin,
        destination: lastManualRouteRef.current.destination,
        package_id: selectedPackageId,
      });
      if (form.is_round_trip) {
        params.set('is_round_trip', 'true');
        if (form.pickup_date) params.set('pickup_date', form.pickup_date);
        if (form.return_date) params.set('return_date', form.return_date);
      }
      runDistanceQuery(params);
      return;
    }

    if (!lastManualRouteRef.current) {
      setDistanceInfo(null);
      setAdjustedPricing(null);
      setDistanceError(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceCoords, destCoords, selectedPackageId, form.is_round_trip, form.pickup_date, form.return_date]);

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
    if (form.is_round_trip) {
      params.set('is_round_trip', 'true');
      if (form.pickup_date) params.set('pickup_date', form.pickup_date);
      if (form.return_date) params.set('return_date', form.return_date);
    }
    runDistanceQuery(params);
  }

  const [packageSearch, setPackageSearch] = useState('');

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

  const visiblePackages = useMemo(() => {
    const q = packageSearch.trim().toLowerCase();
    if (!q) return filteredPackages;
    return filteredPackages.filter((p) => {
      const hay = `${p.name || ''} ${p.cab_type?.display_name || ''} ${p.cab_type?.category || ''} ${p.included_km || ''}km ${p.included_hours || ''}hr`.toLowerCase();
      return hay.includes(q);
    });
  }, [filteredPackages, packageSearch]);

  const selectedPkg = useMemo(
    () => filteredPackages.find((p) => String(p.id) === selectedPackageId) || null,
    [filteredPackages, selectedPackageId]
  );

  const estimatedExtraKm = useMemo(() => {
    if (!distanceInfo || !selectedPkg) return 0;
    const effectiveRoadKm = form.is_round_trip ? distanceInfo.distance_km * 2 : distanceInfo.distance_km;
    const extra = effectiveRoadKm - Number(selectedPkg.included_km || 0);
    return extra > 0 ? Math.round(extra * 10) / 10 : 0;
  }, [distanceInfo, selectedPkg, form.is_round_trip]);

  const isDistanceOutOfRange = Boolean(adjustedPricing && adjustedPricing.withinPackageRange === false);
  const isRouteUnserviced = Boolean(serviceCoverage && serviceCoverage.serviceable === false);
  const isPickupInPast = Boolean(
    form.pickup_date &&
    (form.pickup_date < todayDateStr ||
      (form.pickup_date === todayDateStr && form.pickup_time && form.pickup_time < currentTimeStr))
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPkg) {
      setError('Please select a booking plan/package.');
      return;
    }
    const freshNow = new Date();
    const freshDate = getLocalDateStr(freshNow);
    const freshTime = getLocalTimeStr(freshNow);
    if (
      !form.pickup_date ||
      form.pickup_date < freshDate ||
      (form.pickup_date === freshDate && (!form.pickup_time || form.pickup_time < freshTime))
    ) {
      setNow(freshNow);
      setError('Pickup date and time cannot be in the past. Please choose a current or future date and time.');
      return;
    }
    if (isRouteUnserviced && serviceCoverage?.reason) {
      setError(serviceCoverage.reason);
      return;
    }
    if (isDistanceOutOfRange && adjustedPricing) {
      setError(
        `Route distance (${adjustedPricing.roadDistanceKm} km) exceeds the maximum allowed ${adjustedPricing.maxAllowedKm} km (${selectedPkg.included_km} km + ${adjustedPricing.tolerancePct ?? 20}% tolerance) for "${selectedPkg.name}". Please select a higher-KM package.`
      );
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
          <Link href="/" className="inline-flex items-center text-xs text-slate-600 hover:text-slate-900 mb-1">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Live Dispatch
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Operator Call / Enquiry Booking</h1>
          <p className="text-sm text-slate-600">Enter route with live road distance, pick a cab package from the right panel, and confirm customer details to trigger WhatsApp dispatch</p>
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

      <form onSubmit={handleSubmit} className="grid grid-cols-1 lg:grid-cols-10 gap-6 items-start">
        {/* LEFT COLUMN (70%): Step 1 (Route), Selected Package Summary, Step 3 (Customer & Schedule) */}
        <div className="lg:col-span-7 space-y-5">
          {/* Step 1: Route (Source & Destination Auto-Fill) */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
                <Navigation className="h-4 w-4 mr-2 text-orange-600" /> 1. Route (Source &amp; Destination Auto-Fill)
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
              <div className={`p-3.5 rounded-lg border flex flex-wrap items-center justify-between gap-3 text-xs ${isDistanceOutOfRange
                  ? 'bg-rose-50 border-rose-300'
                  : 'bg-blue-50/70 border-blue-200'
                }`}>
                {distanceLoading ? (
                  <span className="inline-flex items-center text-blue-700 font-medium">
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Calculating driving distance via LocationIQ...
                  </span>
                ) : distanceError ? (
                  <span className="text-amber-800">{distanceError}</span>
                ) : distanceInfo ? (
                  <>
                    <div className={`flex flex-wrap items-center gap-4 font-mono ${isDistanceOutOfRange ? 'text-rose-900' : 'text-blue-900'}`}>
                      <span><strong>Road Distance:</strong> {distanceInfo.distance_km} km{form.is_round_trip ? ` (2x = ${(distanceInfo.distance_km * 2).toFixed(1)} km)` : ''}</span>
                      <span><strong>Est. Drive Time:</strong> {distanceInfo.duration_text}</span>
                      {distanceInfo.cached && <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700">cached</span>}
                    </div>
                    {selectedPkg && isDistanceOutOfRange && adjustedPricing ? (
                      <span className="text-rose-800 font-bold">
                        Out of package range! Max allowed for {selectedPkg.name} is {adjustedPricing.maxAllowedKm} km ({selectedPkg.included_km} km + {adjustedPricing.tolerancePct ?? 20}% tolerance). Please select a higher-KM package.
                      </span>
                    ) : selectedPkg && estimatedExtraKm > 0 ? (
                      <span className="text-amber-800 font-semibold">
                        Exceeds package {selectedPkg.included_km} km by {adjustedPricing?.extraKm ?? estimatedExtraKm} km (within +{adjustedPricing?.tolerancePct ?? 20}% tolerance)
                        {adjustedPricing
                          ? ` → Adjusted Final Payment: ₹${adjustedPricing.totalPayment.toLocaleString('en-IN')}`
                          : ` (Extra ₹${selectedPkg.cab_type.extra_km_charge}/km)`}
                      </span>
                    ) : null}
                  </>
                ) : null}
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Origin City *</label>
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

            {isRouteUnserviced && serviceCoverage?.reason && (
              <div className="p-3.5 rounded-lg bg-rose-50 border border-rose-300 text-rose-900 text-xs font-semibold flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0 mt-0.5" />
                <span>{serviceCoverage.reason}</span>
              </div>
            )}
          </div>

          {/* Selected Package Summary (shown directly below Step 1) */}
          {selectedPkg ? (() => {
            const livePricing = adjustedPricing ?? selectedPkg.pricing;
            const hasExtraKm = Boolean(livePricing && livePricing.extraKm > 0);
            const hasExtraDays = Boolean(livePricing && livePricing.extraDays > 0);
            const extraDayTotal = Number(livePricing?.extraDayCabChargePreGst || 0) + Number(livePricing?.extraDayDriverTaPreGst || 0);
            const selectedTheme = getCabCategoryTheme(selectedPkg.cab_type?.category);
            return (
              <div className="bg-white p-5 rounded-xl border-2 border-orange-300 shadow-sm space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-[11px] font-bold uppercase tracking-wider text-orange-700">Selected Package</span>
                      <span className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-bold ${selectedTheme.badge}`}>
                        {selectedPkg.cab_type.display_name}
                      </span>
                      <span className="inline-block px-2 py-0.5 rounded-full text-[11px] font-bold bg-slate-100 text-slate-800">
                        {selectedPkg.booking_type}{form.is_round_trip ? ' • Round Trip' : ''}
                      </span>
                    </div>
                    <div className="text-lg font-bold text-slate-950">{selectedPkg.name}</div>
                    <div className="text-xs text-slate-700 font-mono">
                      {selectedPkg.included_km} km / {selectedPkg.included_hours} hrs &bull; Per Day (12h): ₹{selectedPkg.cab_type.per_day_charge} &bull; Extra: ₹{selectedPkg.cab_type.extra_hour_charge}/hr, ₹{selectedPkg.cab_type.extra_km_charge}/km
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <div className="text-right bg-orange-50 border border-orange-200 rounded-lg px-3 py-1.5">
                      <div className="text-[10px] font-semibold uppercase text-orange-800">Final Payment</div>
                      <div className="text-lg font-bold font-mono text-orange-800">₹{livePricing.totalPayment.toLocaleString('en-IN')}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setSelectedPackageId('')}
                      title="Clear selected package"
                      className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </div>

                {(hasExtraKm || hasExtraDays || form.is_round_trip) && (
                  <div className="bg-amber-50 border border-amber-200 text-amber-900 rounded-md px-3 py-2 text-xs font-medium flex flex-wrap items-center justify-between gap-2">
                    <span>
                      {form.is_round_trip ? (
                        <><strong>Round Trip ({livePricing.tripDays || 1} {(livePricing.tripDays || 1) === 1 ? 'day' : 'days'}):</strong> </>
                      ) : (
                        <>Distance-adjusted fare: </>
                      )}
                      {hasExtraKm && (
                        <><strong>{livePricing.roadDistanceKm} km</strong> {form.is_round_trip ? '(2x road km) ' : ''}exceeds {selectedPkg.included_km} km by <strong>{livePricing.extraKm} km</strong></>
                      )}
                      {hasExtraKm && hasExtraDays ? ' • ' : ''}
                      {hasExtraDays && (
                        <>+{livePricing.extraDays} extra {livePricing.extraDays === 1 ? 'day' : 'days'} cab &amp; driver TA</>
                      )}
                    </span>
                    <span className="font-mono font-bold">
                      {hasExtraKm ? `+₹${Number(livePricing.extraKmChargePreGst || 0).toFixed(2)} KM` : ''}
                      {hasExtraKm && hasExtraDays ? ' + ' : ''}
                      {hasExtraDays ? `+₹${extraDayTotal.toFixed(2)} Days` : ''}
                    </span>
                  </div>
                )}

                <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-xs font-mono">
                  <div><span className="text-slate-600 block">Total Fair (Pre-GST)</span><strong className="text-slate-900">₹{livePricing.totalFairPreGst.toFixed(2)}</strong></div>
                  <div><span className="text-slate-600 block">GST ({livePricing.gstPct}%)</span><strong className="text-slate-900">₹{livePricing.gstCharge.toFixed(2)}</strong></div>
                  <div><span className="text-slate-600 block">Platform Charge</span><strong className="text-slate-900">₹{Number(livePricing.techFeeAmount || 0).toFixed(2)}</strong></div>
                  <div><span className="text-slate-600 block">Final Payment</span><strong className="text-orange-700">₹{livePricing.totalPayment.toFixed(2)}</strong></div>
                  <div><span className="text-slate-600 block">Admin Comm. ({livePricing.commissionPct}%)</span><strong className="text-slate-900">₹{livePricing.adminCommission.toFixed(2)}</strong></div>
                  <div><span className="text-slate-600 block">Driver Payment</span><strong className="text-emerald-700">₹{livePricing.driverGrossEarnings.toFixed(2)}</strong></div>
                </div>
              </div>
            );
          })() : (
            <div className="bg-slate-50 p-4 rounded-xl border-2 border-dashed border-slate-300 flex items-center justify-between gap-3">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-orange-100 text-orange-700">
                  <Car className="h-5 w-5" />
                </div>
                <div>
                  <div className="text-sm font-bold text-slate-900">No Cab Package Selected</div>
                  <div className="text-xs text-slate-600">Select a booking type and cab package from <strong>2. Select Booking Type &amp; Cab Package</strong> on the right to preview fare breakdown here.</div>
                </div>
              </div>
            </div>
          )}

          {/* Step 3: Customer & Schedule Details */}
          <div className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
            <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
              <Phone className="h-4 w-4 mr-2 text-orange-600" /> 3. Customer &amp; Schedule Details
            </h2>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
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
                <input
                  type="date"
                  required
                  min={todayDateStr}
                  value={form.pickup_date}
                  onChange={(e) => {
                    const nextPickup = e.target.value;
                    const freshNow = new Date();
                    const freshDate = getLocalDateStr(freshNow);
                    const freshTime = getLocalTimeStr(freshNow);
                    setNow(freshNow);
                    setForm((prev) => ({
                      ...prev,
                      pickup_date: nextPickup,
                      pickup_time:
                        nextPickup === freshDate && prev.pickup_time && prev.pickup_time < freshTime
                          ? freshTime
                          : prev.pickup_time,
                      return_date: prev.return_date < nextPickup ? nextPickup : prev.return_date,
                    }));
                  }}
                  className={`w-full mt-1 px-3 py-2 border rounded-md text-sm ${form.pickup_date && form.pickup_date < todayDateStr ? 'border-rose-400 bg-rose-50/40' : ''
                    }`}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-slate-700">Pickup Time *</label>
                <input
                  type="time"
                  required
                  min={form.pickup_date === todayDateStr ? currentTimeStr : undefined}
                  value={form.pickup_time}
                  onChange={(e) => setForm({ ...form, pickup_time: e.target.value })}
                  className={`w-full mt-1 px-3 py-2 border rounded-md text-sm ${isPickupInPast ? 'border-rose-400 bg-rose-50/40' : ''
                    }`}
                />
              </div>
              {form.is_round_trip && (
                <div>
                  <label className="block text-xs font-semibold text-indigo-700">Return Date (Round Trip) *</label>
                  <input
                    type="date"
                    required
                    min={form.pickup_date || todayDateStr}
                    value={form.return_date}
                    onChange={(e) => setForm({ ...form, return_date: e.target.value })}
                    className="w-full mt-1 px-3 py-2 border border-indigo-300 rounded-md text-sm bg-indigo-50/40"
                  />
                </div>
              )}
            </div>

            {isPickupInPast && (
              <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-300 text-rose-800 text-xs font-semibold flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-600 shrink-0" />
                <span>Pickup date &amp; time cannot be in the past. Please select {todayDateStr} {currentTimeStr} or later.</span>
              </div>
            )}

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-center">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700">Special Notes (optional)</label>
                <textarea rows={2} value={form.special_notes} onChange={(e) => setForm({ ...form, special_notes: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
              </div>
              <div className="flex items-center pt-2">
                <label className="flex items-center space-x-2 text-xs font-semibold text-slate-700 cursor-pointer">
                  <input type="checkbox" checked={form.auto_broadcast} onChange={(e) => setForm({ ...form, auto_broadcast: e.target.checked })} className="rounded text-orange-600" />
                  <span>Trigger WhatsApp driver broadcast immediately</span>
                </label>
              </div>
            </div>

            <div className="flex justify-end pt-3 border-t border-slate-200">
              <button
                type="submit"
                disabled={submitting || !selectedPkg || isDistanceOutOfRange || isRouteUnserviced || isPickupInPast}
                className="inline-flex items-center px-5 py-2.5 bg-orange-600 text-white rounded-lg text-sm font-semibold hover:bg-orange-700 disabled:opacity-50"
              >
                <Send className="h-4 w-4 mr-2" />
                {submitting ? 'Booking & Sending WhatsApp...' : 'Confirm Booking & Trigger WhatsApp Workflow'}
              </button>
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN (30%): Step 2 (Select Booking Type & Cab Package — Sticky Scrolling Panel) */}
        <aside className="lg:col-span-3 lg:sticky lg:top-4 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col lg:max-h-[calc(100vh-5rem)] overflow-hidden">
          <div className="p-4 border-b border-slate-200 bg-slate-50/70 space-y-3 shrink-0">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-xs font-bold text-slate-900 uppercase tracking-wider flex items-center">
                <Car className="h-4 w-4 mr-1.5 text-orange-600 shrink-0" /> 2. Select Booking Type &amp; Cab Package
              </h2>
              <span className="text-[11px] font-mono font-semibold px-2 py-0.5 rounded-full bg-slate-200 text-slate-800 shrink-0">
                {visiblePackages.length}
              </span>
            </div>

            {refreshingAvailability && !initialLoading && (
              <div className="inline-flex items-center text-xs text-slate-600">
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin text-orange-500" /> Checking city availability...
              </div>
            )}

            <div className="grid grid-cols-3 gap-1.5">
              {BOOKING_TYPES.map((bt) => (
                <button
                  type="button"
                  key={bt}
                  onClick={() => {
                    setBookingType(bt);
                    setSelectedPackageId('');
                    if (bt !== 'OUTSTATION') {
                      setForm((prev) => ({ ...prev, is_round_trip: false }));
                    }
                  }}
                  className={`px-2 py-2 rounded-lg text-[11px] font-bold border transition text-center ${bookingType === bt
                      ? 'bg-orange-600 text-white border-orange-600'
                      : 'bg-white text-slate-700 border-slate-300 hover:bg-slate-50'
                    }`}
                >
                  {bt === 'LOCAL' ? 'LOCAL' : bt}
                </button>
              ))}
            </div>

            {bookingType === 'OUTSTATION' && (
              <div className="grid grid-cols-2 rounded-lg border border-slate-300 overflow-hidden bg-white">
                <button
                  type="button"
                  onClick={() => setForm((prev) => ({ ...prev, is_round_trip: false }))}
                  className={`px-2.5 py-1.5 text-xs font-bold transition ${!form.is_round_trip ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                >
                  One-Way
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setForm((prev) => ({
                      ...prev,
                      is_round_trip: true,
                      return_date: prev.return_date && prev.return_date >= prev.pickup_date ? prev.return_date : prev.pickup_date,
                    }))
                  }
                  className={`px-2.5 py-1.5 text-xs font-bold transition ${form.is_round_trip ? 'bg-indigo-600 text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                >
                  Round Trip (2x)
                </button>
              </div>
            )}

            <div className="relative">
              <Search className="h-3.5 w-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                value={packageSearch}
                onChange={(e) => setPackageSearch(e.target.value)}
                placeholder="Filter cab or KM (e.g. Sedan, 60KM)..."
                className="w-full pl-8 pr-7 py-1.5 text-xs border border-slate-300 rounded-md bg-white text-slate-900 placeholder:text-slate-500 focus:outline-none focus:ring-2 focus:ring-orange-500"
              />
              {packageSearch && (
                <button
                  type="button"
                  onClick={() => setPackageSearch('')}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-800"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>
          </div>

          <div className="overflow-y-auto p-3 space-y-2.5 flex-1 min-h-[260px]">
            {initialLoading ? (
              <div className="text-xs text-slate-600 py-6 text-center">Loading configured packages...</div>
            ) : filteredPackages.length === 0 ? (
              <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-3">
                {form.origin_city.trim()
                  ? `No free ${bookingType} cabs are currently available in ${form.origin_city.trim()} (all matching cabs may be on ongoing rides or none onboarded in this city).`
                  : <>No active {bookingType} packages configured yet. Add them in <Link href="/catalog" className="underline font-semibold">Cabs, Fuel &amp; Plans</Link>.</>}
              </div>
            ) : visiblePackages.length === 0 ? (
              <div className="text-xs text-slate-600 py-6 text-center">
                No packages match &ldquo;{packageSearch}&rdquo;.
              </div>
            ) : (
              visiblePackages.map((p) => {
                const active = String(p.id) === selectedPackageId;
                const avail = p.availability;
                const unavailable = Boolean(avail && !avail.is_available);
                const theme = getCabCategoryTheme(p.cab_type?.category);
                return (
                  <button
                    type="button"
                    key={p.id}
                    disabled={unavailable}
                    onClick={() => !unavailable && setSelectedPackageId(String(p.id))}
                    className={`w-full text-left p-3.5 rounded-xl border-2 transition ${unavailable
                        ? 'border-slate-200 bg-slate-100 opacity-60 cursor-not-allowed'
                        : active
                          ? `${theme.card} ring-2 ring-orange-500 border-orange-600 shadow-md`
                          : theme.card
                      }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="min-w-0">
                        <span className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-bold mb-1 ${theme.badge}`}>
                          {p.cab_type.display_name}
                        </span>
                        <div className="font-bold text-slate-950 text-sm leading-snug truncate">{p.name}</div>
                        <div className="text-[11px] text-slate-700 font-mono">Per Day: ₹{p.cab_type.per_day_charge}</div>
                      </div>
                      <div className="text-right shrink-0 bg-white/90 px-2 py-1 rounded-lg border border-slate-200">
                        <div className="font-bold text-orange-800 font-mono text-sm">₹{p.pricing.totalPayment.toLocaleString('en-IN')}</div>
                        <div className="text-[10px] text-slate-700 font-medium">incl. GST + fee</div>
                      </div>
                    </div>
                    <div className="text-[11px] text-slate-800 mt-2 font-mono font-medium">
                      {p.included_km} km / {p.included_hours} hrs &bull; +₹{p.cab_type.extra_km_charge}/km, +₹{p.cab_type.extra_hour_charge}/hr
                    </div>
                    {avail ? (
                      <div className="mt-1.5">
                        {avail.is_available ? (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-100 text-emerald-800">
                            {avail.available_cabs}/{avail.total_cabs} {avail.category} free in {avail.city}
                          </span>
                        ) : (
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-100 text-rose-700">
                            0 {avail.category} free in {avail.city}
                          </span>
                        )}
                      </div>
                    ) : (
                      <div className="mt-1.5 text-[10px] text-slate-600">Enter source city in Step 1 for live availability</div>
                    )}
                  </button>
                );
              })
            )}
          </div>
        </aside>
      </form>
    </div>
  );
}
