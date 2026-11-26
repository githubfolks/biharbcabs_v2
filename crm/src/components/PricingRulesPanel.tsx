'use client';

import { useState, useEffect, useCallback } from 'react';
import { Flame, Plus, Trash2, Power } from 'lucide-react';

interface PricingRuleRow {
  id: number;
  name: string;
  rule_type: 'NIGHT' | 'FESTIVAL' | 'PEAK_DATE' | 'CITY_DEMAND';
  booking_type: string | null;
  origin_city: string | null;
  cab_category: string | null;
  start_date: string | null;
  end_date: string | null;
  start_time: string | null;
  end_time: string | null;
  adjustment_type: 'PERCENT' | 'FLAT';
  adjustment_value: number;
  priority: number;
  is_active: boolean;
}

export default function PricingRulesPanel({ canManage }: { canManage: boolean }) {
  const [rules, setRules] = useState<PricingRuleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const [form, setForm] = useState({
    name: '',
    rule_type: 'FESTIVAL' as PricingRuleRow['rule_type'],
    booking_type: '',
    origin_city: '',
    start_date: '',
    end_date: '',
    start_time: '',
    end_time: '',
    adjustment_type: 'PERCENT' as 'PERCENT' | 'FLAT',
    adjustment_value: '15',
  });

  const loadRules = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/catalog/pricing-rules', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) setRules(data.rules || []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRules();
  }, [loadRules]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await fetch('/api/catalog/pricing-rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          booking_type: form.booking_type || null,
          origin_city: form.origin_city || null,
          start_date: form.start_date || null,
          end_date: form.end_date || null,
          start_time: form.start_time || null,
          end_time: form.end_time || null,
          adjustment_value: Number(form.adjustment_value),
        }),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not create surge rule');
      } else {
        setForm({
          name: '',
          rule_type: 'FESTIVAL',
          booking_type: '',
          origin_city: '',
          start_date: '',
          end_date: '',
          start_time: '',
          end_time: '',
          adjustment_type: 'PERCENT',
          adjustment_value: '15',
        });
        await loadRules();
      }
    } finally {
      setSaving(false);
    }
  }

  async function toggleRule(r: PricingRuleRow) {
    await fetch(`/api/catalog/pricing-rules/${r.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !r.is_active }),
    });
    await loadRules();
  }

  async function deleteRule(r: PricingRuleRow) {
    if (!window.confirm(`Delete surge rule "${r.name}"?`)) return;
    await fetch(`/api/catalog/pricing-rules/${r.id}`, { method: 'DELETE' });
    await loadRules();
  }

  return (
    <section className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
      <div>
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
          <Flame className="h-4 w-4 text-orange-600" /> Peak-Season, Night &amp; Festival Surge Rules
        </h2>
        <p className="text-xs text-slate-600 mt-0.5">
          Configure dynamic percentage or flat surcharges (e.g. Chhath Puja, Lagan wedding season, 10 PM–5 AM night pickups) without editing individual cab packages.
        </p>
      </div>

      {error && <div className="p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs font-semibold">{error}</div>}

      {canManage && (
        <form onSubmit={handleCreate} className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Rule Name *</label>
              <input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Chhath Puja Peak" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Type</label>
              <select value={form.rule_type} onChange={(e) => setForm({ ...form, rule_type: e.target.value as any })} className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900">
                <option value="FESTIVAL">Festival / Lagan</option>
                <option value="NIGHT">Night Window</option>
                <option value="PEAK_DATE">Peak Date Range</option>
                <option value="CITY_DEMAND">City Demand</option>
              </select>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Surcharge</label>
              <div className="flex gap-1.5 mt-1">
                <input required type="number" step="0.01" min="1" value={form.adjustment_value} onChange={(e) => setForm({ ...form, adjustment_value: e.target.value })} className="w-full px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-mono bg-white text-slate-900" />
                <select value={form.adjustment_type} onChange={(e) => setForm({ ...form, adjustment_type: e.target.value as any })} className="px-2 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900">
                  <option value="PERCENT">%</option>
                  <option value="FLAT">₹ Flat</option>
                </select>
              </div>
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Origin City (optional)</label>
              <input value={form.origin_city} onChange={(e) => setForm({ ...form, origin_city: e.target.value })} placeholder="All cities" className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Start Date (optional)</label>
              <input type="date" value={form.start_date} onChange={(e) => setForm({ ...form, start_date: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">End Date (optional)</label>
              <input type="date" value={form.end_date} onChange={(e) => setForm({ ...form, end_date: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">Start Time (optional)</label>
              <input type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-700">End Time (optional)</label>
              <input type="time" value={form.end_time} onChange={(e) => setForm({ ...form, end_time: e.target.value })} className="w-full mt-1 px-2.5 py-1.5 border border-slate-300 rounded-md text-xs bg-white text-slate-900" />
            </div>
          </div>
          <div className="flex justify-end">
            <button type="submit" disabled={saving} className="inline-flex items-center px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50">
              <Plus className="h-3.5 w-3.5 mr-1" /> {saving ? 'Adding...' : 'Add Surge Rule'}
            </button>
          </div>
        </form>
      )}

      {loading ? (
        <div className="text-xs text-slate-600 py-4 text-center">Loading surge rules...</div>
      ) : rules.length === 0 ? (
        <div className="text-xs text-slate-600 py-6 text-center bg-slate-50 rounded-lg border border-dashed border-slate-300">
          No surge or night pricing rules configured yet. Standard package fares apply.
        </div>
      ) : (
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="min-w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
              <tr>
                <th className="px-3 py-2">Rule</th>
                <th className="px-3 py-2">Scope</th>
                <th className="px-3 py-2">Window</th>
                <th className="px-3 py-2 text-right">Adjustment</th>
                <th className="px-3 py-2">Status</th>
                {canManage && <th className="px-3 py-2 text-right">Actions</th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rules.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2">
                    <div className="font-bold text-slate-900">{r.name}</div>
                    <div className="text-[10px] font-mono text-slate-600">{r.rule_type}</div>
                  </td>
                  <td className="px-3 py-2 text-slate-700">
                    {r.origin_city || 'All Cities'} &bull; {r.booking_type || 'All Types'}
                  </td>
                  <td className="px-3 py-2 font-mono text-slate-700">
                    {r.start_date || r.end_date ? `${r.start_date || '*'} → ${r.end_date || '*'}` : 'Any Date'}
                    {r.start_time || r.end_time ? ` (${r.start_time || '00:00'}–${r.end_time || '23:59'})` : ''}
                  </td>
                  <td className="px-3 py-2 text-right font-mono font-bold text-orange-700">
                    +{r.adjustment_type === 'PERCENT' ? `${r.adjustment_value}%` : `₹${r.adjustment_value}`}
                  </td>
                  <td className="px-3 py-2">
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                      r.is_active ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-600'
                    }`}>
                      {r.is_active ? 'ACTIVE' : 'PAUSED'}
                    </span>
                  </td>
                  {canManage && (
                    <td className="px-3 py-2 text-right space-x-1.5">
                      <button type="button" onClick={() => toggleRule(r)} className="p-1 text-slate-700 hover:bg-slate-100 rounded" title="Toggle Active">
                        <Power className="h-3.5 w-3.5" />
                      </button>
                      <button type="button" onClick={() => deleteRule(r)} className="p-1 text-rose-600 hover:bg-rose-50 rounded" title="Delete Rule">
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
