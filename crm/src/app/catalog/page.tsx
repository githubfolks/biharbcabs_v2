'use client';

import { useState, useEffect, useMemo } from 'react';
import { Fuel, Car, Package, Shield, PlusCircle, Save, RefreshCw, Pencil, X, Search, Upload } from 'lucide-react';
import { BOOKING_TYPES, CAB_CATEGORIES, FUEL_TYPES } from '@/lib/booking-rules';
import { getCabCategoryTheme } from '@/lib/cab-theme';
import { hasPermission } from '@/lib/permissions';
import PricingRulesPanel from '@/components/PricingRulesPanel';
import SeoRoutesPanel from '@/components/SeoRoutesPanel';

export default function CatalogPage() {
  const [role, setRole] = useState<string | null>(null);
  const [tab, setTab] = useState<'packages' | 'cabs' | 'fuel' | 'driver-plans'>('packages');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [fuelPrices, setFuelPrices] = useState<any[]>([]);
  const [fuelSyncState, setFuelSyncState] = useState<any>(null);
  const [fuelApiConfigured, setFuelApiConfigured] = useState(false);
  const [fuelAutoSyncEnabled, setFuelAutoSyncEnabled] = useState(false);
  const [syncingFuel, setSyncingFuel] = useState(false);
  const [fuelSyncMsg, setFuelSyncMsg] = useState<string | null>(null);
  const [cabTypes, setCabTypes] = useState<any[]>([]);
  const [packages, setPackages] = useState<any[]>([]);
  const [driverPlans, setDriverPlans] = useState<any[]>([]);

  const canManageCatalog = hasPermission(role, 'catalog.manage');
  const canManagePlans = hasPermission(role, 'plans.manage');

  // Forms & edit states
  const EMPTY_CAB = {
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
    image_url: '',
  };
  const EMPTY_PKG = {
    name: '',
    booking_type: 'RENTAL',
    sub_type: '',
    cab_type_id: '',
    included_km: '',
    included_hours: '',
    description: '',
  };
  const EMPTY_DRIVER_PLAN = {
    code: '',
    name: '',
    price_incl_gst: '',
    allowed_trip_types: ['LOCAL', 'RENTAL'] as string[],
    max_fare_limit: '',
    priority_rank: '0',
    description: '',
  };

  const [editingCabId, setEditingCabId] = useState<number | null>(null);
  const [editingPkgId, setEditingPkgId] = useState<number | null>(null);
  const [editingDriverPlanId, setEditingDriverPlanId] = useState<number | null>(null);
  const [uploadingCabImg, setUploadingCabImg] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [pkgTypeFilter, setPkgTypeFilter] = useState<string>('ALL');
  const [pkgCategoryFilter, setPkgCategoryFilter] = useState<string>('ALL');

  const [newCab, setNewCab] = useState(EMPTY_CAB);
  const [newPkg, setNewPkg] = useState(EMPTY_PKG);
  const [newDriverPlan, setNewDriverPlan] = useState(EMPTY_DRIVER_PLAN);

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
      if (f.success) {
        setFuelPrices(f.fuelPrices);
        setFuelSyncState(f.syncState || null);
        setFuelApiConfigured(Boolean(f.apiConfigured));
        setFuelAutoSyncEnabled(Boolean(f.autoSyncEnabled));
      }
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

  async function syncFuelNow() {
    setSyncingFuel(true);
    setFuelSyncMsg(null);
    setError(null);
    try {
      const res = await fetch('/api/catalog/fuel-prices/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ force: true }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Fuel price sync failed');
      } else {
        const updatedList = Object.entries(data.updated || {})
          .map(([k, v]) => `${k}: ₹${v}`)
          .join(', ');
        setFuelSyncMsg(`Synced for ${data.dateIst} (cached for today)${updatedList ? ` — ${updatedList}` : ''}`);
        await loadAll();
      }
    } catch (err: any) {
      setError(err?.message || 'Unable to reach fuel sync endpoint');
    } finally {
      setSyncingFuel(false);
    }
  }

  async function handleUploadCabImage(file: File) {
    setUploadingCabImg(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch('/api/catalog/cab-types/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!data.success) {
        alert(data.error || 'Image upload failed');
      } else {
        setNewCab((prev) => ({ ...prev, image_url: data.image_url }));
      }
    } catch (err: any) {
      alert(err?.message || 'Image upload failed');
    } finally {
      setUploadingCabImg(false);
    }
  }

  async function handleSaveCab(e: React.FormEvent) {
    e.preventDefault();
    const isEdit = editingCabId !== null;
    const res = await fetch(isEdit ? `/api/catalog/cab-types/${editingCabId}` : '/api/catalog/cab-types', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newCab,
        image_url: newCab.image_url.trim() || null,
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
    if (!data.success) return alert(data.error || `Failed to ${isEdit ? 'update' : 'create'} cab type`);
    setEditingCabId(null);
    setNewCab(EMPTY_CAB);
    await loadAll();
  }

  function startEditCab(c: any) {
    setEditingCabId(c.id);
    setNewCab({
      category: c.category,
      fuel_type: c.fuel_type,
      display_name: c.display_name || '',
      mileage_kmpl: String(c.mileage_kmpl ?? ''),
      per_day_charge: String(c.per_day_charge ?? ''),
      base_buffer_minutes: String(c.base_buffer_minutes ?? '30'),
      extra_hour_charge: String(c.extra_hour_charge ?? ''),
      extra_km_charge: String(c.extra_km_charge ?? ''),
      driver_ta: String(c.driver_ta ?? '0'),
      seating_capacity: String(c.seating_capacity ?? '4'),
      luggage_bags: String(c.luggage_bags ?? '2'),
      models_description: c.models_description || '',
      image_url: c.image_url || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  async function handleSavePackage(e: React.FormEvent) {
    e.preventDefault();
    const isEdit = editingPkgId !== null;
    const res = await fetch(isEdit ? `/api/catalog/packages/${editingPkgId}` : '/api/catalog/packages', {
      method: isEdit ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...newPkg,
        sub_type: newPkg.sub_type.trim() || null,
        cab_type_id: Number(newPkg.cab_type_id),
        included_km: Number(newPkg.included_km),
        included_hours: Number(newPkg.included_hours),
      }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || `Failed to ${isEdit ? 'update' : 'create'} package`);
    setEditingPkgId(null);
    setNewPkg(EMPTY_PKG);
    await loadAll();
  }

  function startEditPackage(p: any) {
    setEditingPkgId(p.id);
    setNewPkg({
      name: p.name || '',
      booking_type: p.booking_type || 'OUTSTATION',
      sub_type: p.sub_type || '',
      cab_type_id: String(p.cab_type_id ?? ''),
      included_km: String(p.included_km ?? ''),
      included_hours: String(p.included_hours ?? ''),
      description: p.description || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  async function handleSaveDriverPlan(e: React.FormEvent) {
    e.preventDefault();
    const isEdit = editingDriverPlanId !== null;
    const res = await fetch(isEdit ? `/api/driver-plans/${editingDriverPlanId}` : '/api/driver-plans', {
      method: isEdit ? 'PATCH' : 'POST',
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
    if (!data.success) return alert(data.error || `Failed to ${isEdit ? 'update' : 'create'} driver plan`);
    setEditingDriverPlanId(null);
    setNewDriverPlan(EMPTY_DRIVER_PLAN);
    await loadAll();
  }

  function startEditDriverPlan(p: any) {
    setEditingDriverPlanId(p.id);
    setNewDriverPlan({
      code: p.code || '',
      name: p.name || '',
      price_incl_gst: String(p.price_incl_gst ?? ''),
      allowed_trip_types: Array.isArray(p.allowed_trip_types) ? p.allowed_trip_types : ['LOCAL', 'RENTAL'],
      max_fare_limit: p.max_fare_limit ? String(p.max_fare_limit) : '',
      priority_rank: String(p.priority_rank ?? '0'),
      description: p.description || '',
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  async function toggleDriverPlanActive(p: any) {
    const res = await fetch(`/api/driver-plans/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !p.is_active }),
    });
    const data = await res.json();
    if (!data.success) return alert(data.error || 'Update failed');
    await loadAll();
  }

  const normalizedQuery = searchQuery.trim().toLowerCase();

  const filteredPackages = useMemo(() => {
    return packages.filter((p) => {
      if (pkgTypeFilter !== 'ALL' && p.booking_type !== pkgTypeFilter) return false;
      if (pkgCategoryFilter !== 'ALL' && p.cab_type?.category !== pkgCategoryFilter) return false;
      if (!normalizedQuery) return true;
      const haystack = [
        p.name,
        p.booking_type,
        p.sub_type,
        p.cab_type?.display_name,
        p.cab_type?.category,
        p.cab_type?.fuel_type,
        `${p.included_km}km`,
        `${p.included_hours}hr`,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [packages, pkgTypeFilter, pkgCategoryFilter, normalizedQuery]);

  const filteredCabTypes = useMemo(() => {
    if (!normalizedQuery) return cabTypes;
    return cabTypes.filter((c) => {
      const haystack = [c.display_name, c.category, c.code, c.fuel_type, c.models_description]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [cabTypes, normalizedQuery]);

  const filteredDriverPlans = useMemo(() => {
    if (!normalizedQuery) return driverPlans;
    return driverPlans.filter((p) => {
      const haystack = [p.name, p.code, p.description, ...(p.allowed_trip_types || [])]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [driverPlans, normalizedQuery]);

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
              className={`py-2.5 px-4 text-xs font-semibold rounded-t-lg flex items-center space-x-2 border-b-2 whitespace-nowrap ${tab === t.id ? 'border-orange-600 text-orange-600 bg-white' : 'border-transparent text-slate-500 hover:text-slate-700'
                }`}
            >
              <Icon className="h-4 w-4" />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Search & Filter Bar */}
      {tab !== 'fuel' && (
        <div className="bg-white p-3.5 rounded-lg border border-slate-200 shadow-sm flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="relative flex-1">
            <Search className="h-4 w-4 text-slate-600 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={
                tab === 'packages'
                  ? 'Search packages by name, cab type, fuel, KM, or hours (e.g. Sedan, 40km, Luxury)...'
                  : tab === 'cabs'
                  ? 'Search cab types by name, category, code, or fuel...'
                  : 'Search driver subscription plans by name, code, or trip type...'
              }
              className="w-full pl-9 pr-8 py-2 border border-slate-300 rounded-md text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-orange-500"
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery('')}
                title="Clear search"
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-600 hover:text-slate-900"
              >
                <X className="h-4 w-4" />
              </button>
            )}
          </div>
          {tab === 'packages' && (
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={pkgTypeFilter}
                onChange={(e) => setPkgTypeFilter(e.target.value)}
                aria-label="Filter by booking type"
                className="px-3 py-2 border border-slate-300 rounded-md text-xs font-semibold text-slate-800 bg-white"
              >
                <option value="ALL">All Types</option>
                {BOOKING_TYPES.map((bt) => (
                  <option key={bt} value={bt}>{bt}</option>
                ))}
              </select>
              <select
                value={pkgCategoryFilter}
                onChange={(e) => setPkgCategoryFilter(e.target.value)}
                aria-label="Filter by cab category"
                className="px-3 py-2 border border-slate-300 rounded-md text-xs font-semibold text-slate-800 bg-white"
              >
                <option value="ALL">All Cabs</option>
                {CAB_CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>{cat.replace(/_/g, ' ')}</option>
                ))}
              </select>
              {(searchQuery || pkgTypeFilter !== 'ALL' || pkgCategoryFilter !== 'ALL') && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('');
                    setPkgTypeFilter('ALL');
                    setPkgCategoryFilter('ALL');
                  }}
                  className="px-2.5 py-2 text-xs font-semibold text-orange-700 hover:text-orange-900"
                >
                  Reset
                </button>
              )}
            </div>
          )}
          <div className="text-xs font-mono font-semibold text-slate-700 whitespace-nowrap">
            {tab === 'packages'
              ? `${filteredPackages.length} / ${packages.length} plans`
              : tab === 'cabs'
              ? `${filteredCabTypes.length} / ${cabTypes.length} cabs`
              : `${filteredDriverPlans.length} / ${driverPlans.length} plans`}
          </div>
        </div>
      )}

      {/* TAB 1: BOOKING PACKAGES */}
      {tab === 'packages' && (
        <div className="space-y-6">
          {canManageCatalog && (
            <form
              onSubmit={handleSavePackage}
              className={`bg-white p-5 rounded-lg border shadow-sm space-y-4 ${editingPkgId ? 'border-orange-500 ring-2 ring-orange-100' : 'border-slate-200'}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900 flex items-center space-x-2">
                  {editingPkgId ? <Pencil className="h-4 w-4 text-orange-600" /> : <PlusCircle className="h-4 w-4 text-orange-600" />}
                  <span>{editingPkgId ? `Edit Booking Package #${editingPkgId}` : 'Create Booking Package / Plan'}</span>
                </h3>
                {editingPkgId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPkgId(null);
                      setNewPkg(EMPTY_PKG);
                    }}
                    className="inline-flex items-center text-xs text-slate-600 hover:text-slate-900"
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel Edit
                  </button>
                )}
              </div>
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
                    <option value="">Select active cab type...</option>
                    {cabTypes
                      .filter((c) => c.is_active || (editingPkgId !== null && String(c.id) === newPkg.cab_type_id))
                      .map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.display_name}{!c.is_active ? ' [INACTIVE]' : ''} (PDCRG ₹{c.per_day_charge}, {c.mileage_kmpl} km/l)
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
              <div className="flex justify-end space-x-2">
                {editingPkgId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingPkgId(null);
                      setNewPkg(EMPTY_PKG);
                    }}
                    className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md text-xs font-semibold hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" className="px-4 py-2 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700">
                  {editingPkgId ? 'Update Package' : 'Save Package'}
                </button>
              </div>
            </form>
          )}

          {packages.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-600 text-sm shadow-sm">
              No packages configured yet. Create packages above to publish them to CRM Operators, WhatsApp &amp; WordPress.
            </div>
          ) : filteredPackages.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-8 text-center text-slate-600 text-sm shadow-sm">
              No packages match your search/filters. Try clearing the search box or switching filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {filteredPackages.map((p) => {
                const theme = getCabCategoryTheme(p.cab_type?.category);
                return (
                  <div
                    key={p.id}
                    className={`rounded-xl border-2 p-5 shadow-sm transition space-y-4 ${theme.card}`}
                  >
                    {/* Card Header */}
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className={`px-2.5 py-0.5 rounded-full text-xs font-bold tracking-wide ${theme.badge}`}>
                            {p.cab_type.display_name}
                          </span>
                          <span className="px-2 py-0.5 rounded-md text-xs font-bold bg-white/90 text-slate-800 border border-slate-300">
                            {p.booking_type}{p.sub_type ? ` • ${p.sub_type}` : ''}
                          </span>
                        </div>
                        <h4 className={`text-lg font-bold ${theme.accentText}`}>{p.name}</h4>
                        <div className="text-xs text-slate-800 font-medium flex flex-wrap gap-x-3 gap-y-1">
                          <span>Plan: <strong className="font-mono">{p.included_km} km / {p.included_hours} hr</strong></span>
                          <span>Per Day (12h): <strong className="font-mono">₹{p.cab_type.per_day_charge}</strong></span>
                          <span>Extra: <strong className="font-mono">₹{p.cab_type.extra_hour_charge}/hr &bull; ₹{p.cab_type.extra_km_charge}/km</strong></span>
                        </div>
                      </div>

                      <div className="flex items-center space-x-2 shrink-0">
                        <button
                          disabled={!canManageCatalog}
                          onClick={() => togglePackageActive(p)}
                          className={`px-2.5 py-1 rounded-md text-xs font-bold border ${
                            p.is_active
                              ? 'bg-emerald-600 text-white border-emerald-700'
                              : 'bg-slate-200 text-slate-800 border-slate-300'
                          }`}
                        >
                          {p.is_active ? 'ACTIVE' : 'INACTIVE'}
                        </button>
                        {canManageCatalog && (
                          <button
                            type="button"
                            onClick={() => startEditPackage(p)}
                            className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold bg-white text-slate-900 border border-slate-300 hover:bg-slate-100"
                          >
                            <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                          </button>
                        )}
                      </div>
                    </div>

                    {/* High-Contrast Price Breakdown Box */}
                    <div className="bg-white rounded-lg border border-slate-200 p-3.5 grid grid-cols-2 sm:grid-cols-3 gap-3 text-sm">
                      <div>
                        <span className="block text-xs text-slate-700 font-semibold">Total Fair (Pre-GST)</span>
                        <span className="font-mono font-bold text-slate-950 text-base">₹{p.pricing.totalFairPreGst.toFixed(2)}</span>
                        <span className="block text-xs text-slate-700 font-mono mt-0.5">
                          Fuel ₹{p.pricing.fuelCost.toFixed(2)} + Time ₹{p.pricing.cabTimeCharge.toFixed(2)}
                          {p.pricing.driverTa > 0 ? ` + TA ₹${p.pricing.driverTa.toFixed(2)}` : ''}
                        </span>
                      </div>
                      <div>
                        <span className="block text-xs text-slate-700 font-semibold">GST ({p.pricing.gstPct}%)</span>
                        <span className="font-mono font-bold text-slate-950 text-base">₹{p.pricing.gstCharge.toFixed(2)}</span>
                        <span className="block text-xs text-slate-700 font-mono mt-0.5">
                          Platform: ₹{Number(p.pricing.techFeeAmount || 0).toFixed(2)}
                        </span>
                      </div>
                      <div className="bg-orange-50 rounded-md p-2 border border-orange-200">
                        <span className="block text-xs text-orange-900 font-semibold">Final Payment</span>
                        <span className="font-mono font-bold text-orange-800 text-lg">₹{p.pricing.totalPayment.toFixed(2)}</span>
                      </div>
                      <div>
                        <span className="block text-xs text-slate-700 font-semibold">Admin Comm. ({p.pricing.commissionPct}%)</span>
                        <span className="font-mono font-bold text-indigo-800 text-base">₹{p.pricing.adminCommission.toFixed(2)}</span>
                      </div>
                      <div className="sm:col-span-2 bg-emerald-50 rounded-md p-2 border border-emerald-200">
                        <span className="block text-xs text-emerald-900 font-semibold">Driver Final Payment</span>
                        <span className="font-mono font-bold text-emerald-800 text-base">₹{p.pricing.driverGrossEarnings.toFixed(2)}</span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: CAB TYPES */}
      {tab === 'cabs' && (
        <div className="space-y-6">
          {canManageCatalog && (
            <form
              onSubmit={handleSaveCab}
              className={`bg-white p-5 rounded-lg border shadow-sm space-y-4 ${editingCabId ? 'border-orange-500 ring-2 ring-orange-100' : 'border-slate-200'}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900">
                  {editingCabId ? `Edit Cab Type #${editingCabId}` : 'Add Cab Type + Fuel Variant'}
                </h3>
                {editingCabId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCabId(null);
                      setNewCab(EMPTY_CAB);
                    }}
                    className="inline-flex items-center text-xs text-slate-600 hover:text-slate-900"
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel Edit
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Cab Category</label>
                  <select
                    disabled={editingCabId !== null}
                    value={newCab.category}
                    onChange={(e) => setNewCab({ ...newCab, category: e.target.value })}
                    className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm disabled:bg-slate-100"
                  >
                    {CAB_CATEGORIES.map((c) => <option key={c} value={c}>{c}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Fuel Type (FT)</label>
                  <select
                    disabled={editingCabId !== null}
                    value={newCab.fuel_type}
                    onChange={(e) => setNewCab({ ...newCab, fuel_type: e.target.value })}
                    className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm disabled:bg-slate-100"
                  >
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
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Base Buffer (mins)</label>
                  <input type="number" step="5" min="0" value={newCab.base_buffer_minutes} onChange={(e) => setNewCab({ ...newCab, base_buffer_minutes: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border rounded-md text-sm font-mono" />
                </div>
                <div className="md:col-span-3">
                  <label className="block text-xs font-semibold text-slate-700">Cab Image (shown on Website Frontend)</label>
                  <div className="mt-1 flex flex-wrap items-center gap-3">
                    {newCab.image_url && (
                      <img
                        src={newCab.image_url}
                        alt="Cab preview"
                        className="h-14 w-24 object-cover rounded-md border border-slate-300 bg-slate-50"
                      />
                    )}
                    <label className="inline-flex items-center px-3 py-1.5 rounded-md border border-slate-300 bg-white text-xs font-semibold text-slate-800 hover:bg-slate-50 cursor-pointer">
                      <Upload className="h-3.5 w-3.5 mr-1.5 text-orange-600" />
                      {uploadingCabImg ? 'Uploading…' : 'Upload JPG / PNG / WebP'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        disabled={uploadingCabImg}
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleUploadCabImage(f);
                          e.target.value = '';
                        }}
                      />
                    </label>
                    <input
                      type="text"
                      value={newCab.image_url}
                      onChange={(e) => setNewCab({ ...newCab, image_url: e.target.value })}
                      placeholder="Or paste image URL (https://... or uploaded path)"
                      className="flex-1 min-w-[220px] px-2.5 py-1.5 border rounded-md text-xs font-mono"
                    />
                    {newCab.image_url && (
                      <button
                        type="button"
                        onClick={() => setNewCab({ ...newCab, image_url: '' })}
                        className="text-xs font-semibold text-rose-700 hover:text-rose-900"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </div>
              </div>
              <div className="flex justify-end space-x-2">
                {editingCabId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingCabId(null);
                      setNewCab(EMPTY_CAB);
                    }}
                    className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md text-xs font-semibold hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" className="px-4 py-2 bg-orange-600 text-white rounded-md text-xs font-semibold hover:bg-orange-700">
                  {editingCabId ? 'Update Cab Type' : 'Add Cab Type'}
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
                  <th className="px-4 py-3">Per Day Charge (12h)</th>
                  <th className="px-4 py-3">Extra Charge (/hr)</th>
                  <th className="px-4 py-3">Extra KM</th>
                  <th className="px-4 py-3">Driver TA</th>
                  <th className="px-4 py-3">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {filteredCabTypes.length === 0 ? (
                  <tr>
                    <td colSpan={8} className="px-4 py-8 text-center text-slate-600">
                      No cab types match &ldquo;{searchQuery}&rdquo;.
                    </td>
                  </tr>
                ) : filteredCabTypes.map((c) => {
                  const theme = getCabCategoryTheme(c.category);
                  return (
                    <tr key={c.id} className={theme.rowTint}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          {c.image_url ? (
                            <img
                              src={c.image_url}
                              alt={c.display_name}
                              className="h-12 w-20 object-cover rounded-md border border-slate-300 bg-white shrink-0"
                            />
                          ) : (
                            <div className="h-12 w-20 rounded-md border border-dashed border-slate-300 bg-white/70 flex items-center justify-center text-[10px] font-semibold text-slate-600 shrink-0">
                              No Img
                            </div>
                          )}
                          <div>
                            <span className={`inline-block px-2 py-0.5 rounded text-xs font-bold mb-1 ${theme.badge}`}>
                              {c.category}
                            </span>
                            <div className="font-bold text-slate-950">{c.display_name}</div>
                            <div className="text-xs text-slate-700 font-mono">{c.code}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs font-bold text-slate-900">{c.fuel_type}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900">{c.mileage_kmpl}</td>
                      <td className="px-4 py-3 font-mono font-bold text-slate-950">₹{c.per_day_charge}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900">₹{c.extra_hour_charge}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900">₹{c.extra_km_charge}</td>
                      <td className="px-4 py-3 font-mono font-semibold text-slate-900">₹{c.driver_ta}</td>
                      <td className="px-4 py-3">
                        <div className="flex items-center space-x-2">
                          <button
                            disabled={!canManageCatalog}
                            onClick={() => toggleCabActive(c)}
                            className={`px-2.5 py-0.5 rounded text-xs font-bold ${c.is_active ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-800'}`}
                          >
                            {c.is_active ? 'ACTIVE' : 'INACTIVE'}
                          </button>
                          {canManageCatalog && (
                            <button
                              type="button"
                              onClick={() => startEditCab(c)}
                              className="inline-flex items-center px-2.5 py-0.5 rounded text-xs font-bold bg-white text-slate-900 border border-slate-300 hover:bg-slate-100"
                            >
                              <Pencil className="h-3 w-3 mr-1" /> Edit
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: FUEL PRICES */}
      {tab === 'fuel' && (
        <div className="space-y-4">
          <div className="bg-white p-4 rounded-lg border border-slate-200 shadow-sm flex flex-wrap items-center justify-between gap-3">
            <div className="text-xs text-slate-600 space-y-0.5">
              <div className="font-semibold text-slate-900">
                Daily Fuel Price API Sync {fuelAutoSyncEnabled ? '(Auto-Sync ON — cached per IST day)' : fuelApiConfigured ? '(Manual Sync)' : '(Not Configured)'}
              </div>
              {fuelSyncState?.last_synced_date_ist ? (
                <div>
                  Last synced: <strong className="font-mono">{fuelSyncState.last_synced_date_ist}</strong>
                  {fuelSyncState.synced_at ? ` (${new Date(fuelSyncState.synced_at).toLocaleString('en-IN')})` : ''}
                </div>
              ) : (
                <div>Configure a free Fuel Price API endpoint in <a href="/settings" className="text-orange-600 underline font-semibold">System Settings</a> to enable daily auto-sync.</div>
              )}
              {fuelSyncState?.last_error && (
                <div className="text-rose-600">Last error: {fuelSyncState.last_error}</div>
              )}
              {fuelSyncMsg && <div className="text-emerald-700 font-semibold">{fuelSyncMsg}</div>}
            </div>
            {canManageCatalog && (
              <button
                type="button"
                onClick={syncFuelNow}
                disabled={syncingFuel || !fuelApiConfigured}
                className="inline-flex items-center px-3.5 py-2 bg-emerald-600 text-white rounded-md text-xs font-semibold hover:bg-emerald-700 disabled:opacity-40"
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${syncingFuel ? 'animate-spin' : ''}`} />
                {syncingFuel ? 'Syncing...' : 'Sync from API Now'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {fuelPrices.map((f) => (
              <div key={f.fuel_type} className="bg-white p-5 rounded-lg border border-slate-200 shadow-sm space-y-3">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-slate-900">{f.fuel_type}</span>
                  <span className="text-xs text-slate-500">per {f.unit}</span>
                </div>
                <div className="flex space-x-2">
                  <input
                    key={`${f.fuel_type}-${f.price_per_unit}`}
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
        </div>
      )}

      {/* TAB 4: DRIVER SUBSCRIPTION PLANS */}
      {tab === 'driver-plans' && (
        <div className="space-y-6">
          {canManagePlans && (
            <form
              onSubmit={handleSaveDriverPlan}
              className={`bg-white p-5 rounded-lg border shadow-sm space-y-4 ${editingDriverPlanId ? 'border-indigo-500 ring-2 ring-indigo-100' : 'border-slate-200'}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-bold text-slate-900">
                  {editingDriverPlanId ? `Edit Driver Subscription Plan #${editingDriverPlanId}` : 'Create Driver Subscription Plan'}
                </h3>
                {editingDriverPlanId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingDriverPlanId(null);
                      setNewDriverPlan(EMPTY_DRIVER_PLAN);
                    }}
                    className="inline-flex items-center text-xs text-slate-600 hover:text-slate-900"
                  >
                    <X className="h-3.5 w-3.5 mr-1" /> Cancel Edit
                  </button>
                )}
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">Plan Code</label>
                  <input
                    required
                    disabled={editingDriverPlanId !== null}
                    value={newDriverPlan.code}
                    onChange={(e) => setNewDriverPlan({ ...newDriverPlan, code: e.target.value })}
                    placeholder="LOCAL / OUTSTATION / PREMIUM"
                    className="w-full mt-1 px-3 py-1.5 border rounded-md text-sm font-mono uppercase disabled:bg-slate-100"
                  />
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
              <div className="flex justify-end space-x-2">
                {editingDriverPlanId && (
                  <button
                    type="button"
                    onClick={() => {
                      setEditingDriverPlanId(null);
                      setNewDriverPlan(EMPTY_DRIVER_PLAN);
                    }}
                    className="px-4 py-2 border border-slate-300 text-slate-700 rounded-md text-xs font-semibold hover:bg-slate-50"
                  >
                    Cancel
                  </button>
                )}
                <button type="submit" className="px-4 py-2 bg-indigo-600 text-white rounded-md text-xs font-semibold hover:bg-indigo-700">
                  {editingDriverPlanId ? 'Update Driver Plan' : 'Save Driver Plan'}
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
                {filteredDriverPlans.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-slate-600">
                      {driverPlans.length === 0
                        ? 'No driver subscription plans configured yet. Drivers can send PLANS on WhatsApp once created.'
                        : `No driver plans match "${searchQuery}".`}
                    </td>
                  </tr>
                ) : (
                  filteredDriverPlans.map((p) => (
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
                        <div className="flex items-center space-x-2">
                          <button
                            disabled={!canManagePlans}
                            onClick={() => toggleDriverPlanActive(p)}
                            className={`px-2 py-0.5 rounded text-xs font-semibold ${p.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'}`}
                          >
                            {p.is_active ? 'ACTIVE' : 'INACTIVE'}
                          </button>
                          {canManagePlans && (
                            <button
                              type="button"
                              onClick={() => startEditDriverPlan(p)}
                              className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-indigo-100 hover:text-indigo-800"
                            >
                              <Pencil className="h-3 w-3 mr-1" /> Edit
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Peak-Season, Night & Festival Surge Pricing Rules */}
      <PricingRulesPanel canManage={canManageCatalog} />

      {/* Dynamic Route SEO Pages (WordPress <-> CRM) */}
      <SeoRoutesPanel canManage={canManageCatalog} />
    </div>
  );
}
