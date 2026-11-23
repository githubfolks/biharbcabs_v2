'use client';

import { useState, useEffect } from 'react';
import { Fuel, Car, Package, Shield, PlusCircle, Save, RefreshCw } from 'lucide-react';
import { BOOKING_TYPES, CAB_CATEGORIES, FUEL_TYPES } from '@/lib/booking-rules';
import { hasPermission } from '@/lib/permissions';

export default function CatalogPage() {
  const [role, setRole] = useState<string | null>(null);
  const [tab, setTab] = useState<'packages' | 'cabs' | 'fuel' | 'driver-plans'>('packages');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fuelPrices, setFuelPrices] = useState<any[]>([]);
  const [cabTypes, setCabTypes] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [driverPlans, setDriverPlans] = useState<any[]>([]);

  const canManageCatalog = hasPermission(role, 'catalog.manage');
  const canManagePlans = hasPermission(role, 'plans.manage');

  // Forms
  const [newCab, setNewCab] = useState({
    category: 'SEDAN',
    fuel_type: 'CNG',
    display_name: '',
    mileage_kmpl: '',
    per_day_charge: '',
    base_buffer_minutes: '30',
    extra_hour_charge: '',
    extra_km_charge: '',
    driver_ta: '0',
    seating_capacity: '4',
    luggage_bags: '2',
    models_description: '',
  });

  const [newPkg, setNewPkg] = useState({
    name: '',
    booking_type: 'RENTAL',
    sub_type: '',
    cab_type_id: '',
    included_km: '',
    included_hours: '',
    description: '',
  });

  const [newDriverPlan, setNewDriverPlan] = useState({
    code: '',
    name: '',
    price_incl_gst: '',
    allowed_trip_types: ['LOCAL', 'RENTAL'] as string[],
    max_fare_limit: '',
    priority_rank: '0',
    description: '',
  });

  async function loadAll() {
    setLoading(true);
    setError(null);
    try {
      const [meRes, fRes, cRes, pRes, dpRes] = await Promise.all([
        fetch('/api/auth/me'),
        fetch('/api/catalog/fuel-prices'),
        fetch('/api/catalog/cab-types'),
        fetch('/api/catalog/packages'),
        fetch('/api/driver-plans'),
      ]);
      const [me, f, c, p, dp] = await Promise.all([meRes.json(), fRes.json(), cRes.json(), pRes.json(), dpRes.json()]);
      setRole(me?.user?.role ?? null);
      if (f.success) setFuelPrices(f.fuelPrices);
      if (c.success) setCabTypes(c.cabTypes);
      if (p.success) setPackages(p.packages);
      if (dp.success) setDriverPlans(dp.plans);
    } catch (err: any) {
      setError(err?.message || 'Failed to load catalog data');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadAll();
  }, []);

  async function saveFuel(fuelType: string, priceStr: string) {
    const res = await fetch('/api/catalog/fuel-prices', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fuel_type: fuelType, price_per_unit: Number(priceStr) }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Failed to update fuel price');
    await loadAll();
  }

  async function handleCreateCab(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/catalog/cab-types', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newCab,
        mileage_kmpl: Number(newCab.mileage_kmpl),
        per_day_charge: Number(newCab.per_day_charge),
        base_buffer_minutes: Number(newCab.base_buffer_minutes),
        extra_hour_charge: Number(newCab.extra_hour_charge),
        extra_km_charge: Number(newCab.extra_km_charge),
        driver_ta: Number(newCab.driver_ta),
        seating_capacity: Number(newCab.seating_capacity),
        luggage_bags: Number(newCab.luggage_bags),
      }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Failed to create cab type');
    setNewCab({ ...newCab, display_name: '', mileage_kmpl: '', per_day_charge: '', extra_hour_charge: '', extra_km_charge: '' });
    await loadAll();
  }

  async function toggleCabActive(cab: any) {
    const res = await fetch(`/api/catalog/cab-types/${cab.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !cab.is_active }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Update failed');
    await loadAll();
  }

  async function handleCreatePackage(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/catalog/packages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newPkg,
        cab_type_id: Number(newPkg.cab_type_id),
        included_km: Number(newPkg.included_km),
        included_hours: Number(newPkg.included_hours),
      }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Failed to create package');
    setNewPkg({ ...newPkg, name: '', included_km: '', included_hours: '', description: '' });
    await loadAll();
  }

  async function togglePackageActive(pkg: any) {
    const res = await fetch(`/api/catalog/packages/${pkg.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !pkg.is_active }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Update failed');
    await loadAll();
  }

  async function handleCreateDriverPlan(e: React.FormEvent) {
    e.preventDefault();
    const res = await fetch('/api/driver-plans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: newDriverPlan.code,
        name: newDriverPlan.name,
        price_incl_gst: Number(newDriverPlan.price_incl_gst),
        allowed_trip_types: newDriverPlan.allowed_trip_types,
        max_fare_limit: newDriverPlan.max_fare_limit ? Number(newDriverPlan.max_fare_limit) : null,
        priority_rank: Number(newDriverPlan.priority_rank || 0),
        description: newDriverPlan.description || null,
      }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Failed to create driver plan');
    setNewDriverPlan({ code: '', name: '', price_incl_gst: '', allowed_trip_types: ['LOCAL', 'RENTAL'], max_fare_limit: '', priority_rank: '0', description: '' });
    await loadAll();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Cabs, Fuel Prices &amp; Plans</h1>
          <p className="text-sm text-slate-500">
            Single source of truth for CRM Operator Booking, WhatsApp Bot &amp; WordPress frontend (zero hardcoded rates)
          </p>
        </div>
        <button
          onClick={loadAll}
          className="inline-flex items-center px-3 py-2 border border-slate-300 shadow-sm text-sm font-medium rounded-md text-slate-700 bg-white hover:bg-slate-50"
        >
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg">{error}</div>}

      {/* Tabs */}
      <div className="border-b border-slate-200 flex space-x-2 overflow-x-auto">
        {[
          { id: 'packages', label: 'Booking Packages', icon: Package },
          { id: 'cabs', label: 'Cab Types & Rates', icon: Car },
          { id: 'fuel', label: 'Fuel Prices', icon: Fuel },
          { id: 'driver-plans', label: 'Driver Subscription Plans', icon: Shield },
        ].map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.id}
              onClick={() => setTab(t.id as any)}
              className={`py-2.5 px-4 text-xs font-semibold rounded-t-lg flex items-center space-x-2 border-b-2 whitespace-nowrap ${
                tab === t.id ? 'border-orange-600 text-orange-600 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="h-4 w-4" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: BOOKING PACKAGES */}
      {tab === 'packages' && (
        <div className="space-y-6">
          {canManageCatalog && (
            <form onSubmit={handleCreatePackage} className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
              <h3 className="font-bold text-slate-900 flex items-center space-x-2">
                <PlusCircle className="h-4 w-4 text-orange-600" />
                <span>Create Booking Package / Plan</span>
              </h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Package Name</label>
                  <input
                    required
                    value={newPkg.name}
                    onChange={(e) => setNewPkg({ ...newPkg, name: e.target.value })}
                    placeholder="e.g. 1 Hr / 10 KM Rental"
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Booking Type</label>
                  <select
                    value={newPkg.booking_type}
                    onChange={(e) => setNewPkg({ ...newPkg, booking_type: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  >
                    {BOOKING_TYPES.map((bt) => (
                      <option key={bt} value={bt}>{bt}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Sub-Type (optional)</label>
                  <input
                    value={newPkg.sub_type}
                    onChange={(e) => setNewPkg({ ...newPkg, sub_type: e.target.value })}
                    placeholder="e.g. AIRPORT / RAILWAY_STATION"
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Cab Type (with Fuel)</label>
                  <select
                    required
                    value={newPkg.cab_type_id}
                    onChange={(e) => setNewPkg({ ...newPkg, cab_type_id: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm"
                  >
                    <option value="">Select cab type...</option>
                    {cabTypes.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.display_name} (PDCRG ₹{c.per_day_charge}, {c.mileage_kmpl} km/l)
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Included KM</label>
                  <input
                    type="number"
                    step="0.5"
                    min="1"
                    required
                    value={newPkg.included_km}
                    onChange={(e) => setNewPkg({ ...newPkg, included_km: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Included Hours</label>
                  <input
                    type="number"
                    step="0.5"
                    min="0.5"
                    required
                    value={newPkg.included_hours}
                    onChange={(e) => setNewPkg({ ...newPkg, included_hours: e.target.value })}
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono"
                  />
                </div>
              </div>
              <div className="flex justify-end">
                <button type="submit" className="px-4 py-2 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700">
                  Save Package
                </button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm text-left">
              <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-3">Package</th>
                  <th className="px-4 py-3">Cab &amp; Fuel</th>
                  <th className="px-4 py-3">Plan Limits</th>
                  <th className="px-4 py-3">Total Fair (Pre-GST)</th>
                  <th className="px-4 py-3">GST</th>
                  <th className="px-4 py-3">Total Payment</th>
                  <th className="px-4 py-3">Admin Comm.</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {packages.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-slate-400">
                      No packages configured yet. Create packages above to publish them to CRM Operators, WhatsApp &amp; WordPress.
                    </td>
                  </tr>
                ) : (
                  packages.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500">{p.booking_type}{p.sub_type ? ` • ${p.sub_type}` : ''}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="font-medium">{p.cab_type.display_name}</div>
                        <div className="text-xs text-slate-500">Extra: ₹{p.cab_type.extra_hour_charge}/hr &bull; ₹{p.cab_type.extra_km_charge}/km</div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs">{p.included_km} km / {p.included_hours} hr</td>
                      <td className="px-4 py-3 font-mono">₹{p.pricing.totalFairPreGst.toFixed(2)}</td>
                      <td className="px-4 py-3 font-mono text-xs">₹{p.pricing.gstCharge.toFixed(2)} ({p.pricing.gstPct}%)</td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-900">₹{p.pricing.totalPayment.toFixed(2)}</td>
                      <td className="px-4 py-3 font-mono text-xs text-emerald-700">₹{p.pricing.adminCommission.toFixed(2)} ({p.pricing.commissionPct}%)</td>
                      <td className="px-4 py-3">
                        <button
                          disabled={!canManageCatalog}
                          onClick={() => togglePackageActive(p)}
                          className={`px-2 py-0.5 rounded text-xs font-semibold ${p.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}
                        >
                          {p.is_active ? 'ACTIVE' : 'INACTIVE'}
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: CAB TYPES */}
      {tab === 'cabs' && (
        <div className="space-y-6">
          {canManageCatalog && (
            <form onSubmit={handleCreateCab} className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
              <h3 className="font-bold text-slate-900">Add Cab Type + Fuel Variant</h3>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Cab Category</label>
                  <select value={newCab.category} onChange={(e) => setNewCab({ ...newCab, category: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm">
                    {CAB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Fuel Type (FT)</label>
                  <select value={newCab.fuel_type} onChange={(e) => setNewCab({ ...newCab, fuel_type: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm">
                    {FUEL_TYPES.map((f) => <option key={f} value={f}>{f}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Display Name</label>
                  <input value={newCab.display_name} onChange={(e) => setNewCab({ ...newCab, display_name: e.target.value })} placeholder="e.g. Sedan (CNG)" className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Mileage (CML, km/unit)</label>
                  <input type="number" step="0.1" required value={newCab.mileage_kmpl} onChange={(e) => setNewCab({ ...newCab, mileage_kmpl: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Per-Day Charge (PDCRG ₹)</label>
                  <input type="number" step="1" required value={newCab.per_day_charge} onChange={(e) => setNewCab({ ...newCab, per_day_charge: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Extra Hour Charge (PHEXCHG ₹)</label>
                  <input type="number" step="1" required value={newCab.extra_hour_charge} onChange={(e) => setNewCab({ ...newCab, extra_hour_charge: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Extra KM Charge (₹)</label>
                  <input type="number" step="0.5" required value={newCab.extra_km_charge} onChange={(e) => setNewCab({ ...newCab, extra_km_charge: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Driver TA (₹)</label>
                  <input type="number" step="1" value={newCab.driver_ta} onChange={(e) => setNewCab({ ...newCab, driver_ta: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono" />
                </div>
              </div>
              <div className="flex justify-end">
                <button type="submit" className="px-4 py-2 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700">
                  Add Cab Type
                </button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm text-left">
              <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-3">Cab</th>
                  <th className="px-4 py-3">Fuel</th>
                  <th className="px-4 py-3">Mileage (CML)</th>
                  <th className="px-4 py-3">PDCRG (12h)</th>
                  <th className="px-4 py-3">PHEXCHG (/hr)</th>
                  <th className="px-4 py-3">Extra KM</th>
                  <th className="px-4 py-3">Driver TA</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {cabTypes.map((c) => (
                  <tr key={c.id}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{c.display_name}</div>
                      <div className="text-xs text-slate-500 font-mono">{c.code}</div>
                    </td>
                    <td className="px-4 py-3 font-mono text-xs">{c.fuel_type}</td>
                    <td className="px-4 py-3 font-mono">{c.mileage_kmpl}</td>
                    <td className="px-4 py-3 font-mono">₹{c.per_day_charge}</td>
                    <td className="px-4 py-3 font-mono">₹{c.extra_hour_charge}</td>
                    <td className="px-4 py-3 font-mono">₹{c.extra_km_charge}</td>
                    <td className="px-4 py-3 font-mono">₹{c.driver_ta}</td>
                    <td className="px-4 py-3">
                      <button
                        disabled={!canManageCatalog}
                        onClick={() => toggleCabActive(c)}
                        className={`px-2 py-0.5 rounded text-xs font-semibold ${c.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}
                      >
                        {c.is_active ? 'ACTIVE' : 'INACTIVE'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: FUEL PRICES */}
      {tab === 'fuel' && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          {fuelPrices.map((f) => (
            <div key={f.fuel_type} className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-3">
              <div className="flex items-center justify-between">
                <span className="font-bold text-slate-900">{f.fuel_type}</span>
                <span className="text-xs text-slate-500">per {f.unit}</span>
              </div>
              <div className="flex space-x-2">
                <input
                  type="number"
                  step="0.01"
                  defaultValue={f.price_per_unit}
                  id={`fuel_${f.fuel_type}`}
                  disabled={!canManageCatalog}
                  className="w-full px-3 py-2 border rounded-md text-sm font-mono"
                />
                {canManageCatalog && (
                  <button
                    onClick={() => saveFuel(f.fuel_type, (document.getElementById(`fuel_${f.fuel_type}`) as HTMLInputElement).value)}
                    className="inline-flex items-center px-3 py-2 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700"
                  >
                    <Save className="h-3.5 w-3.5 mr-1" /> Save
                  </button>
                )}
              </div>
              {Number(f.price_per_unit) <= 0 && (
                <p className="text-xs text-amber-700">Set a positive price before activating {f.fuel_type} packages.</p>
              )}
            </div>
          ))}
        </div>
      )}

      {/* TAB 4: DRIVER SUBSCRIPTION PLANS */}
      {tab === 'driver-plans' && (
        <div className="space-y-6">
          {canManagePlans && (
            <form onSubmit={handleCreateDriverPlan} className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-4">
              <h3 className="font-bold text-slate-900">Create Driver Subscription Plan</h3>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Plan Code</label>
                  <input required value={newDriverPlan.code} onChange={(e) => setNewDriverPlan({ ...newDriverPlan, code: e.target.value })} placeholder="LOCAL / OUTSTATION / PREMIUM" className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono uppercase" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Plan Name</label>
                  <input required value={newDriverPlan.name} onChange={(e) => setNewDriverPlan({ ...newDriverPlan, name: e.target.value })} placeholder="e.g. Premium Priority Plan" className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Price (₹ incl. GST)</label>
                  <input type="number" step="1" min="1" required value={newDriverPlan.price_incl_gst} onChange={(e) => setNewDriverPlan({ ...newDriverPlan, price_incl_gst: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Max Fare Limit per Ride (₹, blank = unlimited)</label>
                  <input type="number" step="1" min="1" value={newDriverPlan.max_fare_limit} onChange={(e) => setNewDriverPlan({ ...newDriverPlan, max_fare_limit: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Dispatch Priority Rank (higher = offered first)</label>
                  <input type="number" value={newDriverPlan.priority_rank} onChange={(e) => setNewDriverPlan({ ...newDriverPlan, priority_rank: e.target.value })} className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Allowed Booking Types</label>
                  <div className="flex items-center space-x-3 mt-2">
                    {BOOKING_TYPES.map((bt) => (
                      <label key={bt} className="flex items-center space-x-1 text-xs">
                        <input
                          type="checkbox"
                          checked={newDriverPlan.allowed_trip_types.includes(bt)}
                          onChange={(e) => {
                            const next = e.target.checked
                              ? [...newDriverPlan.allowed_trip_types, bt]
                              : newDriverPlan.allowed_trip_types.filter((t) => t !== bt);
                            setNewDriverPlan({ ...newDriverPlan, allowed_trip_types: next });
                          }}
                        />
                        <span>{bt}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
              <div className="flex justify-end">
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-md text-xs font-semibold hover:bg-indigo-700">
                  Save Driver Plan
                </button>
              </div>
            </form>
          )}

          <div className="bg-white rounded-lg border border-slate-200 shadow-sm overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm text-left">
              <thead className="bg-slate-50 text-xs font-semibold uppercase text-slate-600">
                <tr>
                  <th className="px-4 py-3">Plan</th>
                  <th className="px-4 py-3">Price (incl. GST)</th>
                  <th className="px-4 py-3">Trip Types</th>
                  <th className="px-4 py-3">Fare Limit</th>
                  <th className="px-4 py-3">Priority Rank</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {driverPlans.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-400">
                      No driver subscription plans configured yet. Drivers can send PLANS on WhatsApp once created.
                    </td>
                  </tr>
                ) : (
                  driverPlans.map((p) => (
                    <tr key={p.id}>
                      <td className="px-4 py-3">
                        <div className="font-semibold text-slate-900">{p.name}</div>
                        <div className="text-xs text-slate-500 font-mono">{p.code}</div>
                      </td>
                      <td className="px-4 py-3 font-mono font-bold">₹{p.price_incl_gst.toLocaleString('en-IN')}</td>
                      <td className="px-4 py-3 text-xs font-mono">{p.allowed_trip_types.join(', ')}</td>
                      <td className="px-4 py-3 font-mono text-xs">{p.max_fare_limit ? `Up to ₹${p.max_fare_limit.toLocaleString('en-IN')}` : 'No cap'}</td>
                      <td className="px-4 py-3 font-mono">{p.priority_rank}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded text-xs font-semibold ${p.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}>
                          {p.is_active ? 'ACTIVE' : 'INACTIVE'}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
