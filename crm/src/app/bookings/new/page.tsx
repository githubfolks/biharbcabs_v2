'use client';

import { useState, useEffect, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { Car, Phone, Send, ArrowLeft, CheckCircle2 } from 'lucide-react';
import Link from 'next/link';
import { BOOKING_TYPES } from '@/lib/booking-rules';

export default function OperatorNewBookingPage() {
  const router = useRouter();
  const [packages, setPackages] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ bookingCode: string; offersCreated: number } | null>(null);

  const [bookingType, setBookingType] = useState<string>('OUTSTATION');
  const [selectedPackageId, setSelectedPackageId] = useState<string>('');
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
    setLoading(true);
    fetch('/api/catalog/packages?active=true')
      .then((res) => res.json())
      .then((data) => {
        if (data.success) setPackages(data.packages || []);
        else setError(data.error || 'Could not load packages');
      })
      .catch(() => setError('Could not load booking packages'))
      .finally(() => setLoading(false));
  }, []);

  const filteredPackages = useMemo(
    () => packages.filter((p) => p.booking_type === bookingType),
    [packages, bookingType]
  );

  const selectedPkg = useMemo(
    () => filteredPackages.find((p) => String(p.id) === selectedPackageId) || null,
    [filteredPackages, selectedPackageId]
  );

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
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link href="/" className="inline-flex items-center text-xs text-slate-500 hover:text-slate-800 mb-1">
            <ArrowLeft className="h-3.5 w-3.5 mr-1" /> Back to Live Dispatch
          </Link>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Operator Call / Enquiry Booking</h1>
          <p className="text-sm text-slate-500">Select a configured plan, capture customer details, and trigger the WhatsApp dispatch workflow</p>
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
        {/* Step 1: Booking Type & Plan */}
        <div className="space-y-3">
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <Car className="h-4 w-4 mr-2 text-orange-600" /> 1. Select Booking Type &amp; Cab Plan
          </h2>

          <div className="flex space-x-2">
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

          {loading ? (
            <div className="text-sm text-slate-500 py-4">Loading configured plans...</div>
          ) : filteredPackages.length === 0 ? (
            <div className="text-sm text-amber-700 bg-amber-50 border border-amber-200 rounded-lg p-3">
              No active {bookingType} packages configured yet. Add them in <Link href="/catalog" className="underline font-semibold">Cabs, Fuel &amp; Plans</Link>.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              {filteredPackages.map((p) => {
                const active = String(p.id) === selectedPackageId;
                return (
                  <button
                    type="button"
                    key={p.id}
                    onClick={() => setSelectedPackageId(String(p.id))}
                    className={`text-left p-3.5 rounded-lg border transition ${
                      active ? 'border-orange-600 bg-orange-50/50 ring-2 ring-orange-200' : 'border-slate-200 hover:border-slate-300'
                    }`}
                  >
                    <div className="flex justify-between items-start">
                      <div>
                        <div className="font-bold text-slate-900 text-sm">{p.name}</div>
                        <div className="text-xs text-slate-600">{p.cab_type.display_name}</div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-orange-700 font-mono">₹{p.pricing.totalPayment.toLocaleString('en-IN')}</div>
                        <div className="text-[10px] text-slate-500">incl. {p.pricing.gstPct}% GST</div>
                      </div>
                    </div>
                    <div className="text-[11px] text-slate-500 mt-2 font-mono">
                      {p.included_km} km / {p.included_hours} hrs &bull; Extra: ₹{p.cab_type.extra_hour_charge}/hr, ₹{p.cab_type.extra_km_charge}/km
                    </div>
                  </button>
                );
              })}
            </div>
          )}

          {selectedPkg && (
            <div className="bg-slate-50 border border-slate-200 rounded-lg p-3.5 text-xs grid grid-cols-2 md:grid-cols-4 gap-3 font-mono">
              <div><span className="text-slate-500 block">Total Fair (Pre-GST)</span><strong>₹{selectedPkg.pricing.totalFairPreGst.toFixed(2)}</strong></div>
              <div><span className="text-slate-500 block">GST ({selectedPkg.pricing.gstPct}%)</span><strong>₹{selectedPkg.pricing.gstCharge.toFixed(2)}</strong></div>
              <div><span className="text-slate-500 block">Total Payable</span><strong className="text-orange-700">₹{selectedPkg.pricing.totalPayment.toFixed(2)}</strong></div>
              <div><span className="text-slate-500 block">Driver Payout</span><strong className="text-emerald-700">₹{selectedPkg.pricing.driverGrossEarnings.toFixed(2)}</strong></div>
            </div>
          )}
        </div>

        {/* Step 2: Customer & Trip Details */}
        <div className="space-y-3 border-t pt-5">
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center">
            <Phone className="h-4 w-4 mr-2 text-orange-600" /> 2. Customer &amp; Schedule Details
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Origin City *</label>
              <input required value={form.origin_city} onChange={(e) => setForm({ ...form, origin_city: e.target.value })} placeholder="e.g. Patna, Purnea" className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Destination City</label>
              <input value={form.destination_city} onChange={(e) => setForm({ ...form, destination_city: e.target.value })} placeholder="e.g. Darbhanga / Airport" className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
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

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700">Pickup Date *</label>
              <input type="date" required value={form.pickup_date} onChange={(e) => setForm({ ...form, pickup_date: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700">Pickup Time *</label>
              <input type="time" required value={form.pickup_time} onChange={(e) => setForm({ ...form, pickup_time: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
            </div>
            <div className="flex items-center pt-5">
              <label className="flex items-center space-x-2 text-xs font-semibold text-slate-700 cursor-pointer">
                <input type="checkbox" checked={form.auto_broadcast} onChange={(e) => setForm({ ...form, auto_broadcast: e.target.checked })} className="rounded text-orange-600" />
                <span>Trigger WhatsApp driver broadcast immediately</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">Special Notes (optional)</label>
            <textarea rows={2} value={form.special_notes} onChange={(e) => setForm({ ...form, special_notes: e.target.value })} className="w-full mt-1 px-3 py-2 border rounded-md text-sm" />
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
