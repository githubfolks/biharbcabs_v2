'use client';

import { useState, useEffect, useRef } from 'react';
import { UserCheck, ShieldAlert, Car, PlusCircle, RefreshCw, Wallet, Phone, CheckCircle, Star, AlertTriangle, X, Gift, Award, ShieldCheck, Pencil } from 'lucide-react';
import { allowedActions, DriverStatusAction, REASON_MAX, REASON_MIN } from '@/lib/driver-status-rules';
import DriverEditDialog, { VEHICLE_CATEGORIES } from '@/components/DriverEditDialog';
import DriverWalletDialog from '@/components/DriverWalletDialog';
import { hasPermission } from '@/lib/permissions';

/** Staff-facing line about the WhatsApp message sent after a change (null: none is sent). */
function noticeMessage(name: string, notice: { sent: boolean; error?: string } | null) {
  if (!notice) return { ok: true, text: `Saved. ${name} was not messaged (no message is sent for this change).` };
  return notice.sent
    ? { ok: true, text: `Saved. ${name} was told on WhatsApp.` }
    : { ok: false, text: `Saved, but the WhatsApp message to ${name} was not delivered (${notice.error || 'unknown error'}). It is listed under Failed messages on the dispatch board; tell the driver another way.` };
}

const ACTION_LABEL: Record<DriverStatusAction, string> = { ACTIVATE: 'Activate', SUSPEND: 'Suspend', OFFBOARD: 'Offboard' };

const STATUS_BADGE: Record<string, string> = {
  APPROVED_ACTIVE: 'bg-emerald-100 text-emerald-800',
  PENDING_DOCS: 'bg-sky-100 text-sky-800 border border-sky-300',
  RESTRICTED_DIGITAL_ONLY: 'bg-indigo-100 text-indigo-800 border border-indigo-300',
  SUSPENDED_UNPAID_DUES: 'bg-rose-100 text-rose-800',
  SUSPENDED_DOC_EXPIRED: 'bg-rose-100 text-rose-800',
  SUSPENDED_QUALITY: 'bg-rose-100 text-rose-800',
  SUSPENDED_MANUAL: 'bg-rose-100 text-rose-800 border border-rose-300',
  OFFBOARDED: 'bg-slate-200 text-slate-700',
};

export default function DriversPage() {
  const [drivers, setDrivers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [selectedDriverRating, setSelectedDriverRating] = useState<any | null>(null);
  const [loadingRating, setLoadingRating] = useState(false);
  const [disputeNotes, setDisputeNotes] = useState('');
  const [activeDisputeReviewId, setActiveDisputeReviewId] = useState<number | null>(null);

  // Incentive Modal State
  const [selectedDriverIncentive, setSelectedDriverIncentive] = useState<any | null>(null);
  const [incentiveAmount, setIncentiveAmount] = useState<number>(200);
  const [incentiveReason, setIncentiveReason] = useState<string>('Top Partner Milestone Bonus');
  const [submittingIncentive, setSubmittingIncentive] = useState(false);

  // Status dialog (activate / suspend / offboard)
  const [statusDriver, setStatusDriver] = useState<any | null>(null);
  const [statusDetail, setStatusDetail] = useState<any | null>(null);
  const [statusLoadError, setStatusLoadError] = useState<string | null>(null);
  const [statusAction, setStatusAction] = useState<DriverStatusAction | ''>('');
  const [statusReason, setStatusReason] = useState('');
  const [statusLicense, setStatusLicense] = useState('');
  const [statusVehicles, setStatusVehicles] = useState<any[]>([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [savingStatus, setSavingStatus] = useState(false);
  const [offersReason, setOffersReason] = useState('');
  const [offersError, setOffersError] = useState<string | null>(null);
  const [savingOffers, setSavingOffers] = useState(false);
  const [walletDriver, setWalletDriver] = useState<any | null>(null);
  // What happened to the WhatsApp message after a status change or offer pause.
  const [noticeFlash, setNoticeFlash] = useState<{ ok: boolean; text: string } | null>(null);

  // Expiry dates start empty: the admin must enter the dates printed on the documents.
  const emptyForm = {
    full_name: '',
    phone: '',
    whatsapp_phone: '',
    base_city: 'Patna',
    license_number: '',
    license_expiry: '',
    bank_upi_id: '',
    vehicle: {
      wp_vehicle_code: 'sedan',
      registration_no: '',
      model_name: '',
      insurance_expiry: '',
      fitness_expiry: '',
      permit_expiry: '',
    },
  };
  const [form, setForm] = useState(emptyForm);
  const [onboardError, setOnboardError] = useState<string | null>(null);
  const [onboarding, setOnboarding] = useState(false);
  const setVehicleField = (field: keyof typeof emptyForm.vehicle, value: string) =>
    setForm({ ...form, vehicle: { ...form.vehicle, [field]: value } });

  // Search and filters run on the server. A ref keeps the latest filters for reloads triggered from
  // dialogs, and a request counter drops answers to older requests that arrive late.
  const [filters, setFilters] = useState({ q: '', city: '', status: '' });
  const filtersRef = useRef(filters);
  filtersRef.current = filters;
  const requestSeq = useRef(0);
  const [cities, setCities] = useState<string[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const filtering = Boolean(filters.q.trim() || filters.city || filters.status);

  async function loadDrivers() {
    const seq = ++requestSeq.current;
    const params = new URLSearchParams();
    const f = filtersRef.current;
    if (f.q.trim()) params.set('q', f.q.trim());
    if (f.city) params.set('city', f.city);
    if (f.status) params.set('status', f.status);
    setLoading(true);
    try {
      const res = await fetch(`/api/drivers${params.toString() ? `?${params}` : ''}`);
      const data = await res.json().catch(() => ({}));
      if (seq !== requestSeq.current) return;
      if (res.ok && data.success) {
        setDrivers(data.drivers);
        setCities(data.cities || []);
        setLoadError(null);
      } else {
        setLoadError(data.error || `Could not load drivers (HTTP ${res.status})`);
      }
    } catch {
      if (seq === requestSeq.current) setLoadError('Could not load drivers: network error');
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }

  // Edit dialog; the role only decides what the dialog offers (the API enforces permissions).
  const [editDriverId, setEditDriverId] = useState<number | null>(null);
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me')
      .then((r) => r.json())
      .then((data) => setRole(data?.user?.role ?? null))
      .catch(() => setRole(null));
  }, []);

  // Load on open, and again shortly after the filters stop changing.
  useEffect(() => {
    const t = setTimeout(loadDrivers, filters.q ? 300 : 0);
    return () => clearTimeout(t);
    // loadDrivers reads the filters through filtersRef, so only `filters` is a dependency.
  }, [filters]);

  async function handleOnboardDriver(e: React.FormEvent) {
    e.preventDefault();
    setOnboarding(true);
    setOnboardError(null);
    try {
      const res = await fetch('/api/drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) {
        setShowModal(false);
        setForm(emptyForm);
        loadDrivers();
      } else {
        setOnboardError(data.error || 'Driver not onboarded');
      }
    } catch {
      setOnboardError('Driver not onboarded: network error');
    } finally {
      setOnboarding(false);
    }
  }

  function closeOnboardModal() {
    setShowModal(false);
    setOnboardError(null);
  }

  async function openRatingModal(driver: any) {
    setSelectedDriverRating({ driver, profile: null });
    setLoadingRating(true);
    try {
      const res = await fetch(`/api/drivers/${driver.id}/ratings`);
      const data = await res.json();
      if (data.success) {
        setSelectedDriverRating({ driver, profile: data.profile });
      }
    } catch (err) {
      console.error('Failed to load rating profile:', err);
    } finally {
      setLoadingRating(false);
    }
  }

  async function handleDisputeReview(ratingId: number) {
    if (!disputeNotes.trim()) {
      alert('Please enter justification notes for excluding this review.');
      return;
    }

    try {
      const res = await fetch(`/api/drivers/${selectedDriverRating.driver.id}/ratings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'dispute', ratingId, notes: disputeNotes }),
      });
      const data = await res.json();
      if (data.success) {
        alert('Review disputed and excluded from driver score successfully!');
        setActiveDisputeReviewId(null);
        setDisputeNotes('');
        openRatingModal(selectedDriverRating.driver);
        loadDrivers();
      } else {
        alert(data.error || 'Failed to dispute review');
      }
    } catch (err: any) {
      alert('Error disputing review: ' + err.message);
    }
  }

  async function openStatusModal(driver: any) {
    setStatusDriver(driver);
    setStatusDetail(null);
    setStatusLoadError(null);
    setStatusAction('');
    setStatusReason('');
    setStatusError(null);
    setOffersError(null);
    setNoticeFlash(null);
    try {
      const res = await fetch(`/api/drivers/${driver.id}/status`);
      const data = await res.json();
      if (!data.success) {
        setStatusLoadError(data.error || 'Could not load driver status');
        return;
      }
      setStatusDetail(data);
      setStatusLicense(data.license_expiry || '');
      setStatusVehicles(
        data.vehicles.map((v: any) => ({
          ...v,
          insurance_expiry: v.insurance_expiry || '',
          fitness_expiry: v.fitness_expiry || '',
          permit_expiry: v.permit_expiry || '',
        }))
      );
    } catch {
      setStatusLoadError('Could not load driver status: network error');
    }
  }

  async function handleOffers(paused: boolean) {
    if (!statusDriver) return;
    setSavingOffers(true);
    setOffersError(null);
    try {
      const res = await fetch(`/api/drivers/${statusDriver.id}/offers`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paused, reason: offersReason }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.success) {
        setOffersReason('');
        await openStatusModal(statusDriver);
        setNoticeFlash(noticeMessage(statusDriver.full_name, data.notice));
        loadDrivers();
      } else {
        setOffersError(data.error || 'Not saved');
      }
    } catch {
      setOffersError('Not saved: network error');
    } finally {
      setSavingOffers(false);
    }
  }

  function setStatusVehicleDate(id: number, field: string, value: string) {
    setStatusVehicles((vs) => vs.map((v) => (v.id === id ? { ...v, [field]: value } : v)));
  }

  async function handleStatusChange(e: React.FormEvent) {
    e.preventDefault();
    if (!statusDriver || !statusAction) return;
    setSavingStatus(true);
    setStatusError(null);
    const body: any = { action: statusAction, reason: statusReason };
    if (statusAction === 'ACTIVATE') {
      body.license_expiry = statusLicense;
      body.vehicles = statusVehicles.map((v) => ({
        id: v.id,
        insurance_expiry: v.insurance_expiry,
        fitness_expiry: v.fitness_expiry,
        permit_expiry: v.permit_expiry,
      }));
    }
    try {
      const res = await fetch(`/api/drivers/${statusDriver.id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.success) {
        setNoticeFlash(noticeMessage(statusDriver.full_name, data.notice));
        setStatusDriver(null);
        loadDrivers();
      } else {
        setStatusError(data.error || 'Status not changed');
      }
    } catch {
      setStatusError('Status not changed: network error');
    } finally {
      setSavingStatus(false);
    }
  }

  async function handleAwardIncentive(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedDriverIncentive) return;
    setSubmittingIncentive(true);
    try {
      const res = await fetch(`/api/drivers/${selectedDriverIncentive.id}/incentives`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: Number(incentiveAmount), reason: incentiveReason }),
      });
      const data = await res.json();
      if (data.success) {
        alert(`Incentive of ₹${incentiveAmount} awarded successfully!\nDebt cleared: ₹${data.debtCleared.toFixed(2)}\nNew wallet balance: ₹${data.newWalletBalance.toFixed(2)}`);
        setSelectedDriverIncentive(null);
        loadDrivers();
      } else {
        alert(data.error || 'Failed to award incentive');
      }
    } catch (err: any) {
      alert('Error awarding incentive: ' + err.message);
    } finally {
      setSubmittingIncentive(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Driver & Fleet Verification Hub</h1>
          <p className="text-sm text-slate-500">Manage KYC documents, vehicle categories, and driver wallet ledgers</p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => loadDrivers()}
            className="inline-flex items-center px-3 py-2 border border-slate-300 shadow-sm text-sm font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white bg-orange-600 hover:bg-orange-700"
          >
            <PlusCircle className="h-4 w-4 mr-2" />
            Onboard New Driver
          </button>
        </div>
      </div>

      <div className="flex flex-col sm:flex-row gap-2">
        <input
          type="search"
          value={filters.q}
          onChange={(e) => setFilters({ ...filters, q: e.target.value })}
          placeholder="Search name, phone, licence or vehicle number"
          aria-label="Search drivers"
          maxLength={50}
          className="flex-1 min-w-0 px-3 py-2 border border-slate-300 rounded-md text-sm"
        />
        <select
          value={filters.city}
          onChange={(e) => setFilters({ ...filters, city: e.target.value })}
          aria-label="Filter by city"
          className="px-3 py-2 border border-slate-300 rounded-md text-sm bg-white"
        >
          <option value="">All cities</option>
          {cities.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={filters.status}
          onChange={(e) => setFilters({ ...filters, status: e.target.value })}
          aria-label="Filter by status"
          className="px-3 py-2 border border-slate-300 rounded-md text-sm bg-white"
        >
          <option value="">All statuses</option>
          {Object.keys(STATUS_BADGE).map((s) => (
            <option key={s} value={s}>{s === 'RESTRICTED_DIGITAL_ONLY' ? 'DIGITAL ONLY' : s.replace(/_/g, ' ')}</option>
          ))}
        </select>
        {filtering && (
          <button
            type="button"
            onClick={() => setFilters({ q: '', city: '', status: '' })}
            className="px-3 py-2 text-sm text-slate-600 hover:text-slate-900"
          >
            Clear
          </button>
        )}
      </div>

      {noticeFlash && (
        <div className={`flex items-start justify-between gap-2 p-3 rounded-md text-sm border ${noticeFlash.ok ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-amber-50 border-amber-200 text-amber-800'}`}>
          <span>{noticeFlash.text}</span>
          <button type="button" onClick={() => setNoticeFlash(null)} aria-label="Dismiss" className="text-current opacity-60 hover:opacity-100">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-2 p-3 bg-rose-50 border border-rose-200 rounded-md text-sm text-rose-700">
          <span className="flex items-center">
            <AlertTriangle className="h-4 w-4 mr-1.5 flex-shrink-0" />
            {loadError}
            {drivers.length > 0 && ' The list below may be out of date.'}
          </span>
          <button type="button" onClick={() => loadDrivers()} className="px-3 py-1 bg-white border border-rose-300 rounded text-xs font-semibold hover:bg-rose-100">
            Retry
          </button>
        </div>
      )}

      <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-slate-200 text-left text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs font-semibold uppercase">
              <tr>
                <th className="px-4 py-3">Driver &amp; Contact</th>
                <th className="px-4 py-3">Base City &amp; Vehicle</th>
                <th className="px-4 py-3">Rating &amp; Leeway Tier</th>
                <th className="px-4 py-3">Rolling Reserve</th>
                <th className="px-4 py-3">Wallet &amp; Dues Limit</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200 text-slate-700">
              {drivers.length === 0 ? (
                <tr>
                  <td colSpan={7} className="px-4 py-8 text-center text-slate-400">
                    {loading
                      ? 'Loading drivers...'
                      : loadError
                      ? 'Drivers could not be loaded.'
                      : filtering
                      ? 'No drivers match this search or filter.'
                      : 'No drivers registered yet. Click "Onboard New Driver" to add BiharCabs fleet partners.'}
                  </td>
                </tr>
              ) : (
                drivers.map((d) => (
                  <tr key={d.id} className="hover:bg-slate-50/60 transition">
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900 flex items-center">
                        <UserCheck className="h-4 w-4 mr-1 text-emerald-600" />
                        {d.full_name}
                      </div>
                      <div className="text-xs text-slate-500 flex items-center mt-0.5">
                        <Phone className="h-3 w-3 mr-1" />
                        {d.phone} (WA: {d.whatsapp_phone})
                      </div>
                      <div className="text-[11px] text-slate-400 mt-0.5">
                        DL: <span className="font-mono">{d.license_number || 'Submitted'}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-800">{d.base_city}</div>
                      {d.vehicles && d.vehicles.length > 0 ? (
                        d.vehicles.map((v: any) => (
                          <div key={v.id} className="text-xs text-slate-500">
                            <span>{v.model_name}</span> ({v.registration_no})
                            <span className="ml-1 uppercase text-slate-400 font-mono">[{v.wp_vehicle_code}]</span>
                          </div>
                        ))
                      ) : (
                        <span className="text-xs text-slate-400 italic">No vehicle</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center space-x-1.5">
                        <span
                          className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold ${
                            Number(d.rating) >= 4.8
                              ? 'bg-amber-100 text-amber-800 border border-amber-300'
                              : Number(d.rating) >= 4.2
                              ? 'bg-emerald-100 text-emerald-800'
                              : 'bg-rose-100 text-rose-800'
                          }`}
                        >
                          <Star className="h-3 w-3 mr-1 fill-amber-500 text-amber-500" />
                          {Number(d.rating || 5.0).toFixed(2)}
                        </span>
                        <span className="text-[11px] text-slate-500">
                          ({d.total_ratings_count || 0})
                        </span>
                      </div>
                      <div className="text-[10px] text-slate-400 mt-0.5">
                        {d.total_trips_completed || 0} trips
                      </div>
                      <div className="mt-1">
                        <span className={`inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wider ${
                          d.credit_tier === 'ELITE'
                            ? 'bg-purple-100 text-purple-800 border border-purple-200'
                            : d.credit_tier === 'STANDARD'
                            ? 'bg-blue-100 text-blue-800 border border-blue-200'
                            : 'bg-orange-100 text-orange-800 border border-orange-200'
                        }`}>
                          <Award className="h-2.5 w-2.5 mr-1" />
                          {d.credit_tier || 'PROBATION'}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-mono text-xs font-bold text-slate-800">
                        ₹{Number(d.security_reserve_balance || 0).toFixed(2)}
                        <span className="text-[10px] text-slate-400 font-normal"> / ₹{d.target_security_reserve || 500}</span>
                      </div>
                      <div className="w-24 bg-slate-200 rounded-full h-1.5 mt-1 overflow-hidden">
                        <div
                          className="bg-indigo-600 h-1.5 rounded-full"
                          style={{ width: `${Math.min(100, ((Number(d.security_reserve_balance || 0)) / (d.target_security_reserve || 500)) * 100)}%` }}
                        />
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <div className={`font-mono font-bold flex items-center ${
                        Number(d.wallet_balance) < 0 ? 'text-rose-600' : 'text-emerald-600'
                      }`}>
                        <Wallet className="h-3.5 w-3.5 mr-1" />
                        ₹{Number(d.wallet_balance).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        Limit: -₹{Number(d.dynamic_credit_limit || d.max_negative_balance || 300).toLocaleString('en-IN')}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-semibold uppercase tracking-wide ${
                        STATUS_BADGE[d.onboarding_status] || 'bg-amber-100 text-amber-800'
                      }`}>
                        {d.onboarding_status === 'RESTRICTED_DIGITAL_ONLY' ? 'DIGITAL ONLY' : d.onboarding_status.replace(/_/g, ' ')}
                      </span>
                      {d.offers_paused && (
                        <div className="mt-1">
                          <span className="inline-flex px-1.5 py-0.5 rounded text-[10px] font-bold uppercase bg-amber-100 text-amber-800 border border-amber-300" title={d.offers_paused_reason || ''}>
                            Offers paused
                          </span>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                      {hasPermission(role, 'ledger.view') && (
                        <button
                          onClick={() => setWalletDriver(d)}
                          className="inline-flex items-center px-2 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-medium"
                          title="Wallet ledger entries"
                        >
                          <Wallet className="h-3 w-3 mr-1" />
                          Wallet
                        </button>
                      )}
                      <button
                        onClick={() => setEditDriverId(d.id)}
                        className="inline-flex items-center px-2 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-medium"
                        title="Edit details, payout details and vehicles"
                      >
                        <Pencil className="h-3 w-3 mr-1" />
                        Edit
                      </button>
                      <button
                        onClick={() => openStatusModal(d)}
                        className={`inline-flex items-center px-2 py-1 border rounded text-xs font-semibold ${
                          d.onboarding_status === 'PENDING_DOCS'
                            ? 'bg-sky-600 hover:bg-sky-700 border-sky-600 text-white'
                            : 'bg-white hover:bg-slate-50 border-slate-300 text-slate-700'
                        }`}
                        title="Activate, suspend or offboard this driver"
                      >
                        <ShieldCheck className="h-3 w-3 mr-1" />
                        {d.onboarding_status === 'PENDING_DOCS' ? 'Review' : 'Status'}
                      </button>
                      <button
                        onClick={() => openRatingModal(d)}
                        className="inline-flex items-center px-2 py-1 bg-white hover:bg-slate-50 border border-slate-300 text-slate-700 rounded text-xs font-medium"
                        title="View ratings and dispute customer feedback"
                      >
                        <Star className="h-3 w-3 mr-1 text-amber-500 fill-amber-500" />
                        Reviews
                      </button>
                      <button
                        onClick={() => {
                          setSelectedDriverIncentive(d);
                          setIncentiveAmount(200);
                          setIncentiveReason('Weekly Top Partner Bonus');
                        }}
                        className="inline-flex items-center px-2 py-1 bg-emerald-50 hover:bg-emerald-100 border border-emerald-300 text-emerald-800 rounded text-xs font-semibold"
                        title="Award streak/performance incentive &amp; clear dues"
                      >
                        <Gift className="h-3 w-3 mr-1 text-emerald-600" />
                        Bonus
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Onboard Driver Modal */}
      {showModal && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <h3 className="text-lg font-bold text-slate-900">Onboard Driver & Vehicle</h3>
              <button onClick={closeOnboardModal} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button>
            </div>
            <form onSubmit={handleOnboardDriver} className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Driver Full Name</label>
                  <input
                    type="text"
                    required
                    value={form.full_name}
                    onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. Sunil Kumar Yadav"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Primary Phone</label>
                  <input
                    type="text"
                    required
                    value={form.phone}
                    onChange={(e) => setForm({ ...form, phone: e.target.value, whatsapp_phone: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. 917070992170"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Base / Hub City</label>
                  <input
                    type="text"
                    required
                    value={form.base_city}
                    onChange={(e) => setForm({ ...form, base_city: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. Patna / Gaya / Darbhanga"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Driving License Number</label>
                  <input
                    type="text"
                    required
                    value={form.license_number}
                    onChange={(e) => setForm({ ...form, license_number: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. BR-012022001928"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Licence Valid Until</label>
                  <input
                    type="date"
                    required
                    value={form.license_expiry}
                    onChange={(e) => setForm({ ...form, license_expiry: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">UPI ID for Payouts (optional)</label>
                  <input
                    type="text"
                    value={form.bank_upi_id}
                    onChange={(e) => setForm({ ...form, bank_upi_id: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. name@okaxis"
                  />
                </div>
              </div>

              <div className="pt-2 border-t">
                <span className="text-xs font-bold uppercase tracking-wider text-slate-500">Vehicle Details</span>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Vehicle Category</label>
                  <select
                    value={form.vehicle.wp_vehicle_code}
                    onChange={(e) => setForm({ ...form, vehicle: { ...form.vehicle, wp_vehicle_code: e.target.value } })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  >
                    {VEHICLE_CATEGORIES.map((c) => (
                      <option key={c.code} value={c.code}>{c.label}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Registration Number</label>
                  <input
                    type="text"
                    required
                    value={form.vehicle.registration_no}
                    onChange={(e) => setForm({ ...form, vehicle: { ...form.vehicle, registration_no: e.target.value } })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    placeholder="e.g. BR-01-PK-9821"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Model Name</label>
                <input
                  type="text"
                  required
                  value={form.vehicle.model_name}
                  onChange={(e) => setForm({ ...form, vehicle: { ...form.vehicle, model_name: e.target.value } })}
                  className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  placeholder="e.g. Maruti Suzuki Dzire ZXi White"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                {([
                  ['insurance_expiry', 'Insurance Valid Until'],
                  ['fitness_expiry', 'Fitness Valid Until'],
                  ['permit_expiry', 'Permit Valid Until'],
                ] as const).map(([field, label]) => (
                  <div key={field}>
                    <label className="block text-xs font-semibold text-slate-700">{label}</label>
                    <input
                      type="date"
                      required
                      value={form.vehicle[field]}
                      onChange={(e) => setVehicleField(field, e.target.value)}
                      className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                    />
                  </div>
                ))}
              </div>

              {onboardError && (
                <div className="p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700">{onboardError}</div>
              )}

              <div className="flex justify-end space-x-2 pt-4 border-t">
                <button
                  type="button"
                  onClick={closeOnboardModal}
                  className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={onboarding}
                  className="px-4 py-2 bg-orange-600 text-white rounded-md text-sm font-medium hover:bg-orange-700 disabled:opacity-60"
                >
                  {onboarding ? 'Saving...' : 'Approve & Onboard Driver'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Driver Ratings & Dispute Modal */}
      {selectedDriverRating && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900 flex items-center">
                  <Star className="h-5 w-5 mr-1.5 fill-amber-500 text-amber-500" />
                  Quality & Rating Audit: {selectedDriverRating.driver.full_name}
                </h3>
                <p className="text-xs text-slate-500">
                  {selectedDriverRating.driver.phone} &bull; Base City: {selectedDriverRating.driver.base_city}
                </p>
              </div>
              <button
                onClick={() => setSelectedDriverRating(null)}
                className="text-slate-400 hover:text-slate-600"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {loadingRating ? (
              <div className="py-12 flex justify-center items-center text-slate-400 text-sm">
                <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading rating history...
              </div>
            ) : selectedDriverRating.profile ? (
              <div className="space-y-4">
                {/* Stats Summary Cards */}
                <div className="grid grid-cols-4 gap-3 bg-slate-50 p-3 rounded-lg border border-slate-200 text-center">
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">Current Rating</div>
                    <div className="text-xl font-black text-amber-600 flex items-center justify-center mt-0.5">
                      <Star className="h-4 w-4 mr-1 fill-current" />
                      {selectedDriverRating.profile.currentRating.toFixed(2)}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">Total Trips</div>
                    <div className="text-xl font-black text-slate-800 mt-0.5">
                      {selectedDriverRating.profile.totalTripsCompleted}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">5★ Reviews</div>
                    <div className="text-xl font-black text-emerald-600 mt-0.5">
                      {selectedDriverRating.profile.rating5Count}
                    </div>
                  </div>
                  <div>
                    <div className="text-xs text-slate-500 font-semibold uppercase">1★ Reviews</div>
                    <div className="text-xl font-black text-rose-600 mt-0.5">
                      {selectedDriverRating.profile.rating1Count}
                    </div>
                  </div>
                </div>

                {/* Reviews List */}
                <div>
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">
                    Customer Ratings & Feedback Log
                  </h4>
                  {selectedDriverRating.profile.recentReviews.length === 0 ? (
                    <div className="text-center py-6 text-xs text-slate-400 italic">
                      No ratings submitted yet for this driver.
                    </div>
                  ) : (
                    <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                      {selectedDriverRating.profile.recentReviews.map((rev: any) => (
                        <div
                          key={rev.id}
                          className={`p-3 rounded-lg border text-xs transition ${
                            rev.isDisputed
                              ? 'bg-slate-50/80 border-slate-200 opacity-60'
                              : rev.rating <= 2
                              ? 'bg-rose-50/50 border-rose-200'
                              : 'bg-white border-slate-200'
                          }`}
                        >
                          <div className="flex justify-between items-start">
                            <div className="flex items-center space-x-2">
                              <span
                                className={`px-2 py-0.5 rounded font-bold inline-flex items-center ${
                                  rev.rating >= 4
                                    ? 'bg-emerald-100 text-emerald-800'
                                    : 'bg-rose-100 text-rose-800'
                                }`}
                              >
                                <Star className="h-3 w-3 mr-1 fill-current" />
                                {rev.rating}★
                              </span>
                              {rev.feedbackCategory && (
                                <span className="bg-slate-100 px-2 py-0.5 rounded text-[10px] font-mono font-semibold text-slate-600">
                                  {rev.feedbackCategory}
                                </span>
                              )}
                              <span className="text-slate-400 text-[10px]">
                                {new Date(rev.createdAt).toLocaleDateString('en-IN', {
                                  day: '2-digit',
                                  month: 'short',
                                  hour: '2-digit',
                                  minute: '2-digit',
                                })}
                              </span>
                            </div>

                            {rev.isDisputed ? (
                              <span className="text-[10px] bg-slate-200 text-slate-700 px-2 py-0.5 rounded font-semibold">
                                Disputed & Excluded
                              </span>
                            ) : (
                              <button
                                onClick={() => setActiveDisputeReviewId(rev.id)}
                                className="text-[11px] text-orange-600 hover:text-orange-800 font-semibold"
                              >
                                Exclude / Dispute
                              </button>
                            )}
                          </div>

                          {rev.customerComment && (
                            <p className="mt-1.5 text-slate-600 italic">&ldquo;{rev.customerComment}&rdquo;</p>
                          )}

                          {activeDisputeReviewId === rev.id && (
                            <div className="mt-2.5 pt-2 border-t border-rose-200 space-y-2">
                              <label className="block text-[11px] font-semibold text-slate-700">
                                Admin Dispute Justification (Explain why this rating is excluded from score):
                              </label>
                              <textarea
                                rows={2}
                                value={disputeNotes}
                                onChange={(e) => setDisputeNotes(e.target.value)}
                                placeholder="e.g. Passenger agitated due to highway diversion; driver stayed on official route."
                                className="w-full px-2 py-1 border rounded text-xs"
                              />
                              <div className="flex justify-end space-x-2">
                                <button
                                  type="button"
                                  onClick={() => setActiveDisputeReviewId(null)}
                                  className="px-2 py-1 text-[11px] text-slate-600"
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  onClick={() => handleDisputeReview(rev.id)}
                                  className="px-3 py-1 bg-rose-600 text-white rounded text-[11px] font-semibold hover:bg-rose-700"
                                >
                                  Confirm & Recalculate Score
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ) : null}

            <div className="flex justify-end pt-3 border-t">
              <button
                type="button"
                onClick={() => setSelectedDriverRating(null)}
                className="px-4 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-md text-xs font-semibold"
              >
                Close Audit
              </button>
            </div>
          </div>
        </div>
      )}

      {walletDriver && <DriverWalletDialog driverId={walletDriver.id} onClose={() => setWalletDriver(null)} />}

      {editDriverId !== null && (
        <DriverEditDialog
          driverId={editDriverId}
          role={role}
          onClose={() => setEditDriverId(null)}
          onChanged={loadDrivers}
        />
      )}

      {/* Driver Status Modal: activate / suspend / offboard */}
      {statusDriver && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900 flex items-center">
                  <ShieldCheck className="h-5 w-5 mr-1.5 text-sky-600" />
                  Driver Status: {statusDriver.full_name}
                </h3>
                <p className="text-xs text-slate-500">{statusDriver.phone} &bull; {statusDriver.base_city}</p>
              </div>
              <button onClick={() => setStatusDriver(null)} className="text-slate-400 hover:text-slate-600">
                <X className="h-5 w-5" />
              </button>
            </div>

            {statusLoadError ? (
              <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-700">{statusLoadError}</div>
            ) : !statusDetail ? (
              <div className="py-10 flex justify-center items-center text-slate-400 text-sm">
                <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading status...
              </div>
            ) : (
              <div className="space-y-4">
                <div className="text-sm">
                  Current status:{' '}
                  <span className={`inline-flex px-2 py-0.5 rounded text-[11px] font-semibold uppercase ${STATUS_BADGE[statusDetail.status] || 'bg-amber-100 text-amber-800'}`}>
                    {statusDetail.status.replace(/_/g, ' ')}
                  </span>
                </div>

                <div className={`p-3 rounded-lg border text-xs space-y-2 ${statusDetail.offers.paused ? 'bg-amber-50 border-amber-200' : 'bg-slate-50 border-slate-200'}`}>
                  <div className="font-semibold text-slate-800">
                    Ride offers: {statusDetail.offers.paused ? 'PAUSED' : 'receiving offers'}
                  </div>
                  {statusDetail.offers.paused && (
                    <div className="text-slate-600 break-words">
                      &quot;{statusDetail.offers.reason}&quot; by {statusDetail.offers.by || 'unknown'},{' '}
                      {new Date(statusDetail.offers.at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  )}
                  <p className="text-[11px] text-slate-500">
                    Pausing stops new ride offers without changing the driver&apos;s status. It lasts until someone resumes it. Rides they already hold are not affected.
                  </p>
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={offersReason}
                      onChange={(e) => setOffersReason(e.target.value)}
                      minLength={REASON_MIN}
                      maxLength={REASON_MAX}
                      placeholder={statusDetail.offers.paused ? 'Reason for resuming, e.g. Back from leave' : 'Reason, e.g. On leave until 5 Dec'}
                      className="flex-1 min-w-0 px-2 py-1.5 border rounded text-xs bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => handleOffers(!statusDetail.offers.paused)}
                      disabled={savingOffers || offersReason.trim().length < REASON_MIN}
                      className="px-3 py-1.5 bg-amber-600 text-white rounded text-xs font-bold hover:bg-amber-700 disabled:opacity-50"
                    >
                      {savingOffers ? 'Saving...' : statusDetail.offers.paused ? 'Resume offers' : 'Pause offers'}
                    </button>
                  </div>
                  {offersError && <div className="text-rose-700">{offersError}</div>}
                  {noticeFlash && <div className={noticeFlash.ok ? 'text-emerald-700' : 'text-amber-800'}>{noticeFlash.text}</div>}
                </div>

                {allowedActions(statusDetail.status).length === 0 ? (
                  <p className="text-sm text-slate-500">No manual change is available for this status.</p>
                ) : (
                  <form onSubmit={handleStatusChange} className="space-y-3">
                    <div className="flex flex-wrap gap-2">
                      {allowedActions(statusDetail.status).map((a) => (
                        <label
                          key={a}
                          className={`px-3 py-1.5 border rounded-md text-xs font-semibold cursor-pointer ${
                            statusAction === a ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-300'
                          }`}
                        >
                          <input
                            type="radio"
                            name="status-action"
                            value={a}
                            checked={statusAction === a}
                            onChange={() => setStatusAction(a)}
                            className="sr-only"
                          />
                          {ACTION_LABEL[a]}
                        </label>
                      ))}
                    </div>
                    {['RESTRICTED_DIGITAL_ONLY', 'SUSPENDED_UNPAID_DUES'].includes(statusDetail.status) && (
                      <p className="text-[11px] text-slate-500">
                        This driver is restricted for unpaid dues. The account is restored automatically when the dues are paid (Finance).
                      </p>
                    )}

                    {statusAction === 'ACTIVATE' && (
                      <div className="space-y-3 p-3 bg-slate-50 border border-slate-200 rounded-lg">
                        <p className="text-[11px] text-slate-600">
                          Check each document and enter the date it is valid until. Activation is refused if any date is missing or past,
                          and marks the vehicles as verified.
                        </p>
                        <div className="max-w-xs">
                          <label className="block text-xs font-semibold text-slate-700">Licence Valid Until</label>
                          <input
                            type="date"
                            required
                            value={statusLicense}
                            onChange={(e) => setStatusLicense(e.target.value)}
                            className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm bg-white"
                          />
                        </div>
                        {statusVehicles.length === 0 ? (
                          <p className="text-xs text-rose-700">This driver has no vehicle, so they cannot be activated.</p>
                        ) : (
                          statusVehicles.map((v) => (
                            <div key={v.id}>
                              <div className="text-xs font-semibold text-slate-800">
                                {v.registration_no} <span className="font-normal text-slate-500">{v.model_name} [{v.wp_vehicle_code}]</span>
                              </div>
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-1">
                                {([
                                  ['insurance_expiry', 'Insurance'],
                                  ['fitness_expiry', 'Fitness'],
                                  ['permit_expiry', 'Permit'],
                                ] as const).map(([field, label]) => (
                                  <div key={field}>
                                    <label className="block text-[11px] text-slate-600">{label} valid until</label>
                                    <input
                                      type="date"
                                      required
                                      value={v[field]}
                                      onChange={(e) => setStatusVehicleDate(v.id, field, e.target.value)}
                                      className="w-full mt-0.5 px-2 py-1 border rounded-md text-sm bg-white"
                                    />
                                  </div>
                                ))}
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {statusAction && (
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">Reason (recorded with your name)</label>
                        <textarea
                          rows={2}
                          required
                          minLength={REASON_MIN}
                          maxLength={REASON_MAX}
                          value={statusReason}
                          onChange={(e) => setStatusReason(e.target.value)}
                          placeholder={
                            statusAction === 'ACTIVATE'
                              ? 'e.g. Checked original licence, RC, insurance, fitness and permit'
                              : 'e.g. Customer complaint of misconduct on trip BC-1234, under investigation'
                          }
                          className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                        />
                      </div>
                    )}

                    {statusError && (
                      <div className="p-2 bg-rose-50 border border-rose-200 rounded text-xs text-rose-700">{statusError}</div>
                    )}

                    <div className="flex justify-end">
                      <button
                        type="submit"
                        disabled={!statusAction || savingStatus || (statusAction === 'ACTIVATE' && statusVehicles.length === 0)}
                        className="px-4 py-2 bg-slate-900 text-white rounded-md text-xs font-bold hover:bg-slate-800 disabled:opacity-50"
                      >
                        {savingStatus ? 'Saving...' : statusAction ? `${ACTION_LABEL[statusAction]} Driver` : 'Choose an action'}
                      </button>
                    </div>
                  </form>
                )}

                <div className="border-t pt-3">
                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2">Status History</h4>
                  {statusDetail.history.length === 0 ? (
                    <p className="text-xs text-slate-400 italic">No manual status changes recorded.</p>
                  ) : (
                    <ul className="space-y-1.5 max-h-48 overflow-y-auto text-xs">
                      {statusDetail.history.map((h: any) => (
                        <li key={h.id} className="p-2 bg-slate-50 border border-slate-200 rounded break-words">
                          <span className="font-semibold">{h.action}</span>: {h.from_status} → {h.to_status}
                          <span className="text-slate-500">
                            {' '}by {h.changed_by_name},{' '}
                            {new Date(h.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                          </span>
                          <div className="text-slate-600 italic">&quot;{h.reason}&quot;</div>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Award Driver Incentive / Bonus Modal */}
      {selectedDriverIncentive && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-2xl max-w-md w-full p-6 space-y-4">
            <div className="flex justify-between items-center border-b pb-3">
              <div className="flex items-center space-x-2">
                <Gift className="h-5 w-5 text-emerald-600" />
                <h3 className="text-base font-bold text-slate-900">Award Driver Incentive &amp; Bonus</h3>
              </div>
              <button onClick={() => setSelectedDriverIncentive(null)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button>
            </div>

            <div className="bg-slate-50 p-3 rounded-lg border border-slate-200 text-xs space-y-1.5">
              <div className="flex justify-between">
                <span className="text-slate-500">Driver Partner:</span>
                <span className="font-bold text-slate-900">{selectedDriverIncentive.full_name} ({selectedDriverIncentive.phone})</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Current Wallet Balance:</span>
                <span className={`font-mono font-bold ${Number(selectedDriverIncentive.wallet_balance) < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                  ₹{Number(selectedDriverIncentive.wallet_balance).toFixed(2)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-500">Onboarding Status:</span>
                <span className="font-semibold uppercase text-slate-700">{selectedDriverIncentive.onboarding_status}</span>
              </div>
              {Number(selectedDriverIncentive.wallet_balance) < 0 && (
                <div className="mt-2 p-2 bg-amber-50 border border-amber-200 rounded text-[11px] text-amber-800">
                  ⚠️ <strong>Automated Debt Offsetting:</strong> This bonus will automatically route to clear their ₹{Math.abs(Number(selectedDriverIncentive.wallet_balance)).toFixed(2)} negative dues first, unlocking their account for high-value dispatch!
                </div>
              )}
            </div>

            <form onSubmit={handleAwardIncentive} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">Bonus Amount (₹)</label>
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={incentiveAmount}
                  onChange={(e) => setIncentiveAmount(parseFloat(e.target.value))}
                  required
                  className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono font-bold text-emerald-700"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">Reason / Milestone Campaign</label>
                <input
                  type="text"
                  value={incentiveReason}
                  onChange={(e) => setIncentiveReason(e.target.value)}
                  placeholder="e.g. 5-Trip Ride Streak Milestone or Festive Partner Bonus"
                  required
                  className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                />
              </div>

              <div className="flex justify-end space-x-2 pt-3 border-t">
                <button
                  type="button"
                  onClick={() => setSelectedDriverIncentive(null)}
                  className="px-4 py-2 border rounded-md text-xs font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={submittingIncentive}
                  className="px-4 py-2 bg-emerald-600 text-white rounded-md text-xs font-bold hover:bg-emerald-700 flex items-center"
                >
                  <Gift className="h-4 w-4 mr-1.5" />
                  {submittingIncentive ? 'Credit in Progress...' : 'Credit Bonus & Settle'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

