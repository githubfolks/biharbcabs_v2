'use client';

import { useState, useEffect, useCallback } from 'react';
import { Handshake, Plus, RefreshCw, Copy, Wallet, Power } from 'lucide-react';

interface PartnerRow {
  id: number;
  partner_name: string;
  partner_type: 'HOTEL' | 'TRAVEL_DESK' | 'AGENT';
  city: string;
  contact_name: string;
  phone: string;
  referral_code: string;
  commission_type: 'PERCENT' | 'FLAT';
  commission_value: number;
  wallet_balance: number;
  upi_id: string | null;
  is_active: boolean;
  referred_bookings: number;
  earned_commission: number;
}

function fmtInr(n: number | undefined | null): string {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function PartnersPage() {
  const [partners, setPartners] = useState<PartnerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const [form, setForm] = useState({
    partner_name: '',
    partner_type: 'HOTEL' as PartnerRow['partner_type'],
    city: '',
    contact_name: '',
    phone: '',
    referral_code: '',
    commission_type: 'PERCENT' as 'PERCENT' | 'FLAT',
    commission_value: '5',
    upi_id: '',
  });

  const loadPartners = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/partners', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) setPartners(data.partners || []);
      else setError(data.error || 'Could not load partners');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPartners();
  }, [loadPartners]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/partners', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...form, commission_value: Number(form.commission_value) }),
      });
      const data = await res.json();
      if (!data.success) setError(data.error || 'Failed to create partner');
      else {
        setNotice(`Created partner '${data.partner.partner_name}' (ref: ${data.partner.referral_code}).`);
        setForm({ partner_name: '', partner_type: 'HOTEL', city: '', contact_name: '', phone: '', referral_code: '', commission_type: 'PERCENT', commission_value: '5', upi_id: '' });
        await loadPartners();
      }
    } finally {
      setCreating(false);
    }
  }

  async function handlePayout(p: PartnerRow) {
    const amtStr = window.prompt(`Enter payout amount (₹) for ${p.partner_name}:`, String(Math.max(0, p.wallet_balance)));
    if (!amtStr) return;
    const ref = window.prompt('Enter UPI / NEFT UTR reference:');
    if (!ref) return;
    const res = await fetch(`/api/partners/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_payout: { amount: Number(amtStr), reference: ref, channel: 'UPI' } }),
    });
    const data = await res.json();
    if (data.success) {
      setNotice(`Recorded payout of ₹${amtStr} to ${p.partner_name}.`);
      await loadPartners();
    } else {
      setError(data.error || 'Payout failed');
    }
  }

  async function toggleActive(p: PartnerRow) {
    await fetch(`/api/partners/${p.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ is_active: !p.is_active }),
    });
    await loadPartners();
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Handshake className="h-6 w-6 text-orange-600" /> Hotel &amp; Travel-Desk Partner Program
          </h1>
          <p className="text-sm text-slate-600">
            Issue referral codes to hotels, travel desks, and wedding planners; track referred bookings, commission wallets, and partner payouts.
          </p>
        </div>
        <button type="button" onClick={loadPartners} className="inline-flex items-center px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {notice && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-medium">{notice}</div>}
      {error && <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm font-medium">{error}</div>}

      {/* Add Partner Form */}
      <form onSubmit={handleCreate} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
          <Plus className="h-4 w-4 text-orange-600" /> Register Hotel / Travel-Desk Partner
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input required value={form.partner_name} onChange={(e) => setForm({ ...form, partner_name: e.target.value })} placeholder="Hotel / Agency Name *" className="px-3 py-2 border border-slate-300 rounded-md text-xs text-slate-900" />
          <select value={form.partner_type} onChange={(e) => setForm({ ...form, partner_type: e.target.value as any })} className="px-3 py-2 border border-slate-300 rounded-md text-xs bg-white text-slate-900">
            <option value="HOTEL">Hotel Front Desk</option>
            <option value="TRAVEL_DESK">Travel Desk / Tour Operator</option>
            <option value="AGENT">Independent Agent</option>
          </select>
          <input required value={form.city} onChange={(e) => setForm({ ...form, city: e.target.value })} placeholder="City (e.g. Patna) *" className="px-3 py-2 border border-slate-300 rounded-md text-xs text-slate-900" />
          <input required value={form.referral_code} onChange={(e) => setForm({ ...form, referral_code: e.target.value.toUpperCase() })} placeholder="Referral Code (e.g. MAURYA_PATNA) *" className="px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
          <input required value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} placeholder="Contact Name *" className="px-3 py-2 border border-slate-300 rounded-md text-xs text-slate-900" />
          <input required value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="Phone *" className="px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
          <div className="flex gap-1.5">
            <input required type="number" min="0" step="0.5" value={form.commission_value} onChange={(e) => setForm({ ...form, commission_value: e.target.value })} placeholder="Comm." className="w-full px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
            <select value={form.commission_type} onChange={(e) => setForm({ ...form, commission_type: e.target.value as any })} className="px-2 py-2 border border-slate-300 rounded-md text-xs bg-white text-slate-900">
              <option value="PERCENT">%</option>
              <option value="FLAT">₹</option>
            </select>
          </div>
          <button type="submit" disabled={creating} className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold hover:bg-orange-700 disabled:opacity-50">
            {creating ? 'Registering...' : 'Add Partner'}
          </button>
        </div>
      </form>

      {/* Partners Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
              <tr>
                <th className="px-4 py-3">Partner</th>
                <th className="px-4 py-3">Referral Code</th>
                <th className="px-4 py-3 text-right">Commission</th>
                <th className="px-4 py-3 text-right">Referred Rides</th>
                <th className="px-4 py-3 text-right">Wallet Payable</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-600">Loading partners...</td></tr>
              ) : partners.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-600">No hotel or travel-desk partners registered yet.</td></tr>
              ) : (
                partners.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-900 text-sm">{p.partner_name}</div>
                      <div className="text-[11px] text-slate-600">{p.partner_type} &bull; {p.city} &bull; {p.contact_name} ({p.phone})</div>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        type="button"
                        onClick={() => {
                          navigator.clipboard?.writeText(`?ref=${p.referral_code}`);
                          setNotice(`Copied referral query "?ref=${p.referral_code}"`);
                        }}
                        className="inline-flex items-center px-2 py-1 rounded bg-slate-100 hover:bg-slate-200 font-mono font-bold text-slate-800"
                        title="Copy referral query string"
                      >
                        {p.referral_code} <Copy className="h-3 w-3 ml-1.5 text-slate-600" />
                      </button>
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-semibold text-slate-800">
                      {p.commission_type === 'PERCENT' ? `${p.commission_value}%` : fmtInr(p.commission_value)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-800">{p.referred_bookings}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-emerald-700">{fmtInr(p.wallet_balance)}</td>
                    <td className="px-4 py-3 text-right space-x-1.5 whitespace-nowrap">
                      <button type="button" onClick={() => handlePayout(p)} className="inline-flex items-center px-2.5 py-1 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700">
                        <Wallet className="h-3.5 w-3.5 mr-1" /> Payout
                      </button>
                      <button type="button" onClick={() => toggleActive(p)} className="p-1.5 border rounded text-slate-700 hover:bg-slate-100" title="Toggle Active">
                        <Power className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
