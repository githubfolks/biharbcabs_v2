'use client';

import { useState, useEffect, useCallback } from 'react';
import { Building2, Plus, Download, Users, CreditCard, RefreshCw, X, Trash2 } from 'lucide-react';

interface CorporateAccount {
  id: number;
  company_name: string;
  gstin: string | null;
  billing_address: string | null;
  contact_name: string;
  contact_phone: string;
  contact_email: string | null;
  credit_limit: number;
  current_outstanding: number;
  discount_pct: number;
  is_active: boolean;
  members_count: number;
  bookings_count: number;
  total_billed: number;
}

function fmtInr(n: number | undefined | null): string {
  return `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export default function CorporateB2BPage() {
  const [accounts, setAccounts] = useState<CorporateAccount[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [month, setMonth] = useState(() => new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().slice(0, 7));

  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({
    company_name: '',
    gstin: '',
    contact_name: '',
    contact_phone: '',
    contact_email: '',
    credit_limit: '50000',
    discount_pct: '5',
  });

  // Detail modal
  const [selected, setSelected] = useState<CorporateAccount | null>(null);
  const [members, setMembers] = useState<any[]>([]);
  const [empForm, setEmpForm] = useState({ employee_name: '', phone: '', department: '' });
  const [payForm, setPayForm] = useState({ amount: '', reference: '' });

  const loadAccounts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/corporate', { cache: 'no-store' });
      const data = await res.json();
      if (data.success) setAccounts(data.accounts || []);
      else setError(data.error || 'Could not load corporate accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAccounts();
  }, [loadAccounts]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/corporate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...form,
          credit_limit: Number(form.credit_limit),
          discount_pct: Number(form.discount_pct),
        }),
      });
      const data = await res.json();
      if (!data.success) setError(data.error || 'Failed to create corporate account');
      else {
        setNotice(`Created B2B account '${data.account.company_name}'.`);
        setForm({ company_name: '', gstin: '', contact_name: '', contact_phone: '', contact_email: '', credit_limit: '50000', discount_pct: '5' });
        await loadAccounts();
      }
    } finally {
      setCreating(false);
    }
  }

  async function openDetail(acc: CorporateAccount) {
    setSelected(acc);
    const res = await fetch(`/api/corporate/${acc.id}`, { cache: 'no-store' });
    const data = await res.json();
    if (data.success) setMembers(data.members || []);
  }

  async function addMember(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const res = await fetch(`/api/corporate/${selected.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add_member: empForm }),
    });
    if ((await res.json()).success) {
      setEmpForm({ employee_name: '', phone: '', department: '' });
      await openDetail(selected);
      await loadAccounts();
    }
  }

  async function removeMember(memberId: number) {
    if (!selected) return;
    await fetch(`/api/corporate/${selected.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ remove_member_id: memberId }),
    });
    await openDetail(selected);
    await loadAccounts();
  }

  async function recordPayment(e: React.FormEvent) {
    e.preventDefault();
    if (!selected) return;
    const res = await fetch(`/api/corporate/${selected.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record_payment: { amount: Number(payForm.amount), reference: payForm.reference } }),
    });
    const data = await res.json();
    if (data.success) {
      setNotice(`Recorded B2B payment of ₹${payForm.amount} for ${selected.company_name}.`);
      setPayForm({ amount: '', reference: '' });
      setSelected({ ...selected, current_outstanding: Number(data.account.current_outstanding) });
      await loadAccounts();
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Building2 className="h-6 w-6 text-orange-600" /> Corporate B2B Accounts
          </h1>
          <p className="text-sm text-slate-600">
            Manage corporate credit limits, whitelisted employee phones, B2B GSTINs, invoice payments, and consolidated monthly statements.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-300 rounded-lg bg-white text-slate-900" />
          <button type="button" onClick={loadAccounts} className="inline-flex items-center px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50">
            <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
        </div>
      </div>

      {notice && <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm font-medium">{notice}</div>}
      {error && <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-sm font-medium">{error}</div>}

      {/* Create Corporate Account */}
      <form onSubmit={handleCreate} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-3">
        <h2 className="text-xs font-bold uppercase tracking-wider text-slate-800 flex items-center gap-1.5">
          <Plus className="h-4 w-4 text-orange-600" /> Onboard Corporate B2B Account
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <input required value={form.company_name} onChange={(e) => setForm({ ...form, company_name: e.target.value })} placeholder="Company Name *" className="px-3 py-2 border border-slate-300 rounded-md text-xs text-slate-900" />
          <input value={form.gstin} onChange={(e) => setForm({ ...form, gstin: e.target.value.toUpperCase() })} placeholder="GSTIN (optional)" className="px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
          <input required value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} placeholder="Contact Person *" className="px-3 py-2 border border-slate-300 rounded-md text-xs text-slate-900" />
          <input required value={form.contact_phone} onChange={(e) => setForm({ ...form, contact_phone: e.target.value })} placeholder="Contact Phone *" className="px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
          <input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} placeholder="Billing Email" className="px-3 py-2 border border-slate-300 rounded-md text-xs text-slate-900" />
          <input type="number" min="0" value={form.credit_limit} onChange={(e) => setForm({ ...form, credit_limit: e.target.value })} placeholder="Credit Limit (₹)" className="px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
          <input type="number" min="0" max="50" step="0.5" value={form.discount_pct} onChange={(e) => setForm({ ...form, discount_pct: e.target.value })} placeholder="B2B Discount (%)" className="px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900" />
          <button type="submit" disabled={creating} className="px-4 py-2 rounded-lg bg-orange-600 text-white text-xs font-semibold hover:bg-orange-700 disabled:opacity-50">
            {creating ? 'Creating...' : 'Create B2B Account'}
          </button>
        </div>
      </form>

      {/* Accounts Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-slate-50 border-b border-slate-200 text-slate-600 uppercase font-semibold">
              <tr>
                <th className="px-4 py-3">Company / GSTIN</th>
                <th className="px-4 py-3">Contact</th>
                <th className="px-4 py-3 text-right">Employees</th>
                <th className="px-4 py-3 text-right">Credit Limit</th>
                <th className="px-4 py-3 text-right">Outstanding</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-600">Loading accounts...</td></tr>
              ) : accounts.length === 0 ? (
                <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-600">No corporate B2B accounts onboarded yet.</td></tr>
              ) : (
                accounts.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="font-bold text-slate-900 text-sm">{a.company_name}</div>
                      <div className="font-mono text-[11px] text-slate-600">{a.gstin || 'No GSTIN'} &bull; {a.discount_pct}% B2B disc.</div>
                    </td>
                    <td className="px-4 py-3 text-slate-700">
                      <div>{a.contact_name}</div>
                      <div className="font-mono text-[11px] text-slate-600">{a.contact_phone}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono text-slate-800">{a.members_count}</td>
                    <td className="px-4 py-3 text-right font-mono text-slate-800">{fmtInr(a.credit_limit)}</td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-rose-700">{fmtInr(a.current_outstanding)}</td>
                    <td className="px-4 py-3 text-right space-x-2 whitespace-nowrap">
                      <button type="button" onClick={() => openDetail(a)} className="inline-flex items-center px-2.5 py-1 rounded border border-slate-300 bg-white text-slate-800 font-semibold hover:bg-slate-100">
                        <Users className="h-3.5 w-3.5 mr-1" /> Manage
                      </button>
                      <a
                        href={`/api/corporate/${a.id}/statement?month=${encodeURIComponent(month)}&format=csv`}
                        download
                        className="inline-flex items-center px-2.5 py-1 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700"
                      >
                        <Download className="h-3.5 w-3.5 mr-1" /> {month} CSV
                      </a>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Manage Modal */}
      {selected && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-y-auto p-5 space-y-5">
            <div className="flex items-center justify-between border-b pb-3">
              <div>
                <h3 className="text-base font-bold text-slate-900">{selected.company_name}</h3>
                <div className="text-xs font-mono text-slate-600">Outstanding: {fmtInr(selected.current_outstanding)} / Limit: {fmtInr(selected.credit_limit)}</div>
              </div>
              <button type="button" onClick={() => setSelected(null)} className="p-1 text-slate-600"><X className="h-5 w-5" /></button>
            </div>

            {/* Record Corporate Invoice Payment */}
            <form onSubmit={recordPayment} className="p-3.5 rounded-lg bg-emerald-50 border border-emerald-200 space-y-2">
              <div className="text-xs font-bold text-emerald-900 flex items-center gap-1.5"><CreditCard className="h-4 w-4" /> Record Monthly Invoice Payment</div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                <input required type="number" step="0.01" min="1" value={payForm.amount} onChange={(e) => setPayForm({ ...payForm, amount: e.target.value })} placeholder="Amount Received (₹)" className="px-2.5 py-1.5 border rounded text-xs bg-white font-mono" />
                <input required minLength={4} value={payForm.reference} onChange={(e) => setPayForm({ ...payForm, reference: e.target.value })} placeholder="NEFT / UTR / Cheque Ref" className="px-2.5 py-1.5 border rounded text-xs bg-white font-mono" />
                <button type="submit" className="px-3 py-1.5 rounded bg-emerald-600 text-white text-xs font-bold hover:bg-emerald-700">Record Payment</button>
              </div>
            </form>

            {/* Whitelisted Employees */}
            <div className="space-y-2">
              <div className="text-xs font-bold uppercase text-slate-700">Whitelisted Employees ({members.length})</div>
              <form onSubmit={addMember} className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <input required value={empForm.employee_name} onChange={(e) => setEmpForm({ ...empForm, employee_name: e.target.value })} placeholder="Employee Name *" className="px-2.5 py-1.5 border rounded text-xs" />
                <input required value={empForm.phone} onChange={(e) => setEmpForm({ ...empForm, phone: e.target.value })} placeholder="Phone *" className="px-2.5 py-1.5 border rounded text-xs font-mono" />
                <input value={empForm.department} onChange={(e) => setEmpForm({ ...empForm, department: e.target.value })} placeholder="Department" className="px-2.5 py-1.5 border rounded text-xs" />
                <button type="submit" className="px-3 py-1.5 rounded bg-orange-600 text-white text-xs font-bold hover:bg-orange-700">Add Employee</button>
              </form>
              <div className="divide-y border rounded-lg">
                {members.length === 0 ? (
                  <div className="p-3 text-xs text-slate-600 text-center">No employees whitelisted yet.</div>
                ) : (
                  members.map((m) => (
                    <div key={m.id} className="px-3 py-2 flex items-center justify-between text-xs">
                      <div>
                        <span className="font-semibold text-slate-900">{m.employee_name}</span>{' '}
                        <span className="font-mono text-slate-600">({m.phone})</span>
                        {m.department && <span className="ml-2 text-slate-600">• {m.department}</span>}
                      </div>
                      <button type="button" onClick={() => removeMember(m.id)} className="text-rose-600 p-1 hover:bg-rose-50 rounded">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
