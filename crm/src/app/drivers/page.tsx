'use client';

import { useState, useEffect } from 'react';
import { UserCheck, ShieldAlert, Car, PlusCircle, RefreshCw, Wallet, Phone, CheckCircle, Star, AlertTriangle, X, Gift, Award, ShieldCheck } from 'lucide-react';

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

  const [form, setForm] = useState({
    full_name: '',
    phone: '',
    whatsapp_phone: '',
    base_city: 'Patna',
    license_number: '',
    license_expiry: '2028-12-31',
    bank_upi_id: '',
    vehicle: {
      wp_vehicle_code: 'sedan',
      registration_no: '',
      model_name: 'Maruti Suzuki Dzire',
      insurance_expiry: '2027-12-31',
      fitness_expiry: '2027-12-31',
      permit_expiry: '2027-12-31',
    },
  });

  async function loadDrivers() {
    setLoading(true);
    try {
      const res = await fetch('/api/drivers');
      const data = await res.json();
      if (data.success) {
        setDrivers(data.drivers);
      }
    } catch (err) {
      console.error('Failed to load drivers:', err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDrivers();
  }, []);

  async function handleOnboardDriver(e: React.FormEvent) {
    e.preventDefault();
    try {
      const res = await fetch('/api/drivers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (data.success) {
        setShowModal(false);
        loadDrivers();
      } else {
        alert(data.error || 'Failed to onboard driver');
      }
    } catch (err: any) {
      alert('Error onboarding driver: ' + err.message);
    }
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
                    No drivers registered yet. Click &quot;Onboard New Driver&quot; to add BiharCabs fleet partners.
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
                        d.onboarding_status === 'APPROVED_ACTIVE'
                          ? 'bg-emerald-100 text-emerald-800'
                          : d.onboarding_status === 'RESTRICTED_DIGITAL_ONLY'
                          ? 'bg-indigo-100 text-indigo-800 border border-indigo-300'
                          : d.onboarding_status === 'SUSPENDED_UNPAID_DUES'
                          ? 'bg-rose-100 text-rose-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}>
                        {d.onboarding_status === 'RESTRICTED_DIGITAL_ONLY' ? 'DIGITAL ONLY' : d.onboarding_status.replace(/_/g, ' ')}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
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
              <button onClick={() => setShowModal(false)} className="text-slate-400 hover:text-slate-600 text-xl font-bold">&times;</button>
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
                    <option value="sedan">Sedan (Dzire / Etios)</option>
                    <option value="ertiga">Ertiga SUV (6+1)</option>
                    <option value="innova">Innova Crysta</option>
                    <option value="tempo">Tempo Traveller</option>
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

              <div className="flex justify-end space-x-2 pt-4 border-t">
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="px-4 py-2 border rounded-md text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 bg-orange-600 text-white rounded-md text-sm font-medium hover:bg-orange-700"
                >
                  Approve & Onboard Driver
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
                            <p className="mt-1.5 text-slate-600 italic">"{rev.customerComment}"</p>
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

