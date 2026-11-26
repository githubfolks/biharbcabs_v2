'use client';

import { useState, useEffect, useCallback } from 'react';
import { Globe, Plus, Trash2, Power, ExternalLink } from 'lucide-react';

interface SeoRouteRow {
  id: number;
  slug: string;
  origin_city: string;
  destination_city: string | null;
  booking_type: 'OUTSTATION' | 'LOCAL' | 'RENTAL';
  page_title: string;
  meta_description: string;
  hero_heading: string;
  distance_km: number | null;
  drive_time_text: string | null;
  is_published: boolean;
}

export default function SeoRoutesPanel({ canManage }: { canManage: boolean }) {
  const [routes, setRoutes] = useState<SeoRouteRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    slug: '',
    origin_city: '',
    destination_city: '',
    booking_type: 'OUTSTATION' as SeoRouteRow['booking_type'],
    distance_km: '',
    drive_time_text: '',
    hero_heading: '',
  });

  const loadRoutes = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/seo-routes', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) setRoutes(data.routes || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRoutes();
  }, [loadRoutes]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/seo-routes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          distance_km: form.distance_km ? Number(form.distance_km) : null,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not create SEO route');
      } else {
        setForm({ slug: '', origin_city: '', destination_city: '', booking_type: 'OUTSTATION', distance_km: '', drive_time_text: '', hero_heading: '' });
        await loadRoutes();
      }
    } finally {
      setSaving(false);
    }
  }

  async function togglePublish(r: SeoRouteRow) {
    await fetch(`/api/seo-routes/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_published: !r.is_published }),
    });
    await loadRoutes();
  }

  async function deleteRoute(r: SeoRouteRow) {
    if (!window.confirm(`Delete SEO route /cab/${r.slug}/?`)) return;
    await fetch(`/api/seo-routes/${r.id}`, { method: 'DELETE' });
    await loadRoutes();
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
      <div>
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
          <Globe className="h-4 w-4 text-orange-600" /> Dynamic Route SEO Pages (WordPress ↔ CRM)
        </h2>
        <p className="text-xs text-slate-600 mt-0.5">
          Publish city-pair landing pages (e.g. <span className="font-mono">/cab/patna-to-darbhanga-cab/</span>) on WordPress automatically hydrated with live CRM fares, structured JSON-LD schema, and instant booking.
        </p>
      </div>

      {error && <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold">{error}</div>}

      {canManage && (
        <form onSubmit={handleCreate} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">URL Slug *</label>
              <input required value={form.slug} onChange={(e) => setForm({ ...form, slug: e.target.value.toLowerCase() })} placeholder="patna-to-gaya-cab" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-mono bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Origin City *</label>
              <input required value={form.origin_city} onChange={(e) => setForm({ ...form, origin_city: e.target.value })} placeholder="Patna" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Destination City</label>
              <input value={form.destination_city} onChange={(e) => setForm({ ...form, destination_city: e.target.value })} placeholder="Gaya" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Booking Type</label>
              <select value={form.booking_type} onChange={(e) => setForm({ ...form, booking_type: e.target.value as any })} className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900">
                <option value="OUTSTATION">OUTSTATION</option>
                <option value="LOCAL">LOCAL</option>
                <option value="RENTAL">RENTAL</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Distance (KM)</label>
              <input type="number" step="0.1" value={form.distance_km} onChange={(e) => setForm({ ...form, distance_km: e.target.value })} placeholder="105" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-mono bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Est. Drive Time</label>
              <input value={form.drive_time_text} onChange={(e) => setForm({ ...form, drive_time_text: e.target.value })} placeholder="2 hrs 45 mins" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div className="sm:col-span-2">
              <label className="block text-[11px] font-semibold text-slate-700">Hero Heading (optional)</label>
              <input value={form.hero_heading} onChange={(e) => setForm({ ...form, hero_heading: e.target.value })} placeholder="Patna to Gaya AC Cab Service" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="inline-flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
              <Plus className="h-3.5 w-3.5 mr-1" /> {saving ? 'Publishing...' : 'Publish SEO Route'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-xs text-slate-600 py-4 text-center">Loading SEO routes...</div>
      ) : routes.length === 0 ? (
        <div className="text-xs text-slate-600 py-6 text-center bg-slate-50 rounded-lg border border-dashed border-slate-300">
          No SEO route pages configured yet.
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
              <tr>
                <th className="px-3 py-2">Slug / URL</th>
                <th className="px-3 py-2">Route</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Distance</th>
                <th className="px-3 py-2">Status</th>
                {canManage && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {routes.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 font-mono font-bold text-blue-700">
                    <a href={`http://localhost:8081/?bc_seo_route=${encodeURIComponent(r.slug)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center hover:underline">
                      /cab/{r.slug}/ <ExternalLink className="h-3 w-3 ml-1" />
                    </a>
                  </td>
                  <td className="px-3 py-2 font-semibold text-slate-900">
                    {r.origin_city} → {r.destination_city || 'Local'}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-700">{r.booking_type}</td>
                  <td className="px-3 py-2 font-mono text-slate-700">
                    {r.distance_km ? `${r.distance_km} km` : '—'}{r.drive_time_text ? ` (${r.drive_time_text})` : ''}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      r.is_published ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {r.is_published ? 'PUBLISHED' : 'DRAFT'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-right space-x-1.5">
                      <button type="button" onClick={() => togglePublish(r)} className="p-1 text-slate-700 hover:bg-slate-100 rounded" title="Toggle Published">
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => deleteRoute(r)} className="p-1 text-rose-600 hover:bg-rose-50 rounded" title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
