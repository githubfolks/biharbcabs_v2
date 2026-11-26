'use client';

import { useState, useEffect, useCallback } from 'react';
import { ShieldCheck, UserPlus, KeyRound, LogOut, RefreshCw, CheckCircle2, Ban, X } from 'lucide-react';
import { ROLES, Role } from '@/lib/permissions';

interface StaffUser {
  id: number;
  email: string;
  full_name: string;
  role: Role;
  phone: string | null;
  is_active: boolean;
  last_login_at: string | null;
  created_at: string;
  active_sessions: number;
}

const ROLE_BADGE: Record<string, string> = {
  SUPER_ADMIN: 'bg-purple-100 text-purple-800 border-purple-200',
  DISPATCHER: 'bg-blue-100 text-blue-800 border-blue-200',
  FINANCE_MANAGER: 'bg-emerald-100 text-emerald-800 border-emerald-200',
};

function fmtTime(iso: string | null): string {
  if (!iso) return 'Never';
  return new Date(iso).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export default function StaffUsersPage() {
  const [users, setUsers] = useState<StaffUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const [creating, setCreating] = useState(false);
  const [newForm, setNewForm] = useState({
    full_name: '',
    email: '',
    phone: '',
    role: 'DISPATCHER' as Role,
    password: '',
  });

  const [resetTarget, setResetTarget] = useState<StaffUser | null>(null);
  const [resetPassword, setResetPassword] = useState('');
  const [busyId, setBusyId] = useState<number | null>(null);

  const loadUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/users', { cache: 'no-store' });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not load staff accounts');
      } else {
        setUsers(data.users || []);
      }
    } catch {
      setError('Network error while loading staff accounts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(newForm),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Could not create staff user');
      } else {
        setNotice(`Created staff account ${data.user.email} (${data.user.role}).`);
        setNewForm({ full_name: '', email: '', phone: '', role: 'DISPATCHER', password: '' });
        await loadUsers();
      }
    } catch {
      setError('Network error while creating staff user');
    } finally {
      setCreating(false);
    }
  }

  async function patchUser(userId: number, payload: Record<string, unknown>, successMsg: string) {
    setBusyId(userId);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/users/${userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!data.success) {
        setError(data.error || 'Update failed');
      } else {
        setNotice(successMsg);
        await loadUsers();
      }
    } catch {
      setError('Network error while updating staff user');
    } finally {
      setBusyId(null);
    }
  }

  async function handleResetSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!resetTarget) return;
    await patchUser(
      resetTarget.id,
      { new_password: resetPassword },
      `Password reset and active sessions revoked for ${resetTarget.email}.`
    );
    setResetTarget(null);
    setResetPassword('');
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-orange-600" /> Staff &amp; Access Control
          </h1>
          <p className="text-sm text-slate-600">
            Manage CRM operators, assign roles (Super Admin, Dispatcher, Finance Manager), reset passwords, and force-logout active sessions.
          </p>
        </div>
        <button
          type="button"
          onClick={loadUsers}
          className="inline-flex items-center px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 bg-white text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {notice && (
        <div className="p-3 bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg font-medium">
          {notice}
        </div>
      )}
      {error && (
        <div className="p-3 bg-rose-50 border border-rose-200 text-rose-700 text-sm rounded-lg font-medium">
          {error}
        </div>
      )}

      {/* Add Staff Member Form */}
      <form onSubmit={handleCreate} className="bg-white p-5 rounded-xl border border-slate-200 shadow-sm space-y-4">
        <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
          <UserPlus className="h-4 w-4 text-orange-600" /> Add New Staff Member
        </h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div>
            <label className="block text-xs font-semibold text-slate-700">Full Name *</label>
            <input
              required
              value={newForm.full_name}
              onChange={(e) => setNewForm({ ...newForm, full_name: e.target.value })}
              placeholder="e.g. Amit Kumar"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700">Email *</label>
            <input
              required
              type="email"
              value={newForm.email}
              onChange={(e) => setNewForm({ ...newForm, email: e.target.value })}
              placeholder="amit@biharcabs.com"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700">Phone (optional)</label>
            <input
              value={newForm.phone}
              onChange={(e) => setNewForm({ ...newForm, phone: e.target.value })}
              placeholder="919876543210"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm font-mono text-slate-900"
            />
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700">Role *</label>
            <select
              value={newForm.role}
              onChange={(e) => setNewForm({ ...newForm, role: e.target.value as Role })}
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900 bg-white"
            >
              {ROLES.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-semibold text-slate-700">Temporary Password (10+ chars) *</label>
            <input
              required
              minLength={10}
              type="password"
              value={newForm.password}
              onChange={(e) => setNewForm({ ...newForm, password: e.target.value })}
              placeholder="Min 10 characters"
              className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900"
            />
          </div>
        </div>
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={creating}
            className="inline-flex items-center px-4 py-2 bg-orange-600 text-white rounded-lg text-xs font-semibold hover:bg-orange-700 disabled:opacity-50"
          >
            <UserPlus className="h-4 w-4 mr-1.5" />
            {creating ? 'Creating...' : 'Create Staff Account'}
          </button>
        </div>
      </form>

      {/* Staff Directory Table */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="bg-slate-50 border-b border-slate-200 text-xs uppercase text-slate-600 font-semibold">
              <tr>
                <th className="px-4 py-3">Staff Member</th>
                <th className="px-4 py-3">Role</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Sessions</th>
                <th className="px-4 py-3">Last Login (IST)</th>
                <th className="px-4 py-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {loading ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-600 text-sm">
                    Loading staff accounts...
                  </td>
                </tr>
              ) : users.length === 0 ? (
                <tr>
                  <td colSpan={6} className="px-4 py-8 text-center text-slate-600 text-sm">
                    No staff accounts found.
                  </td>
                </tr>
              ) : (
                users.map((u) => (
                  <tr key={u.id} className={!u.is_active ? 'bg-slate-50/80' : 'hover:bg-slate-50/60'}>
                    <td className="px-4 py-3">
                      <div className="font-semibold text-slate-900">{u.full_name}</div>
                      <div className="text-xs text-slate-600 font-mono">{u.email}</div>
                      {u.phone && <div className="text-[11px] text-slate-600 font-mono">{u.phone}</div>}
                    </td>
                    <td className="px-4 py-3">
                      <select
                        disabled={busyId === u.id}
                        value={u.role}
                        onChange={(e) =>
                          patchUser(u.id, { role: e.target.value }, `Updated role for ${u.email} to ${e.target.value}.`)
                        }
                        className={`text-xs font-bold px-2.5 py-1 rounded-md border ${
                          ROLE_BADGE[u.role] || 'bg-slate-100 text-slate-800 border-slate-200'
                        }`}
                      >
                        {ROLES.map((r) => (
                          <option key={r} value={r}>
                            {r}
                          </option>
                        ))}
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      {u.is_active ? (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800">
                          <CheckCircle2 className="h-3 w-3 mr-1" /> Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
                          <Ban className="h-3 w-3 mr-1" /> Deactivated
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-slate-800">
                      {u.active_sessions} active
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-700">{fmtTime(u.last_login_at)}</td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          type="button"
                          disabled={busyId === u.id}
                          onClick={() => {
                            setResetTarget(u);
                            setResetPassword('');
                          }}
                          className="inline-flex items-center px-2.5 py-1.5 text-xs font-semibold rounded-md border border-slate-300 text-slate-700 hover:bg-slate-100"
                        >
                          <KeyRound className="h-3.5 w-3.5 mr-1" /> Reset Password
                        </button>
                        {u.active_sessions > 0 && (
                          <button
                            type="button"
                            disabled={busyId === u.id}
                            onClick={() =>
                              patchUser(u.id, { revoke_sessions: true }, `Revoked active sessions for ${u.email}.`)
                            }
                            className="inline-flex items-center px-2.5 py-1.5 text-xs font-semibold rounded-md border border-amber-300 bg-amber-50 text-amber-900 hover:bg-amber-100"
                          >
                            <LogOut className="h-3.5 w-3.5 mr-1" /> Force Logout
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={busyId === u.id}
                          onClick={() =>
                            patchUser(
                              u.id,
                              { is_active: !u.is_active },
                              `${u.is_active ? 'Deactivated' : 'Reactivated'} ${u.email}.`
                            )
                          }
                          className={`px-2.5 py-1.5 text-xs font-semibold rounded-md border ${
                            u.is_active
                              ? 'border-rose-300 text-rose-700 hover:bg-rose-50'
                              : 'border-emerald-300 text-emerald-700 hover:bg-emerald-50'
                          }`}
                        >
                          {u.is_active ? 'Deactivate' : 'Activate'}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Password Reset Modal */}
      {resetTarget && (
        <div className="fixed inset-0 z-50 bg-slate-900/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl border border-slate-200 shadow-xl max-w-md w-full p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900">Reset Password</h3>
              <button
                type="button"
                onClick={() => setResetTarget(null)}
                className="p-1 text-slate-600 hover:text-slate-900"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <p className="text-xs text-slate-600">
              Setting a new password for <strong>{resetTarget.full_name}</strong> ({resetTarget.email}) will immediately sign out all their active sessions.
            </p>
            <form onSubmit={handleResetSubmit} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700">New Password (10+ characters) *</label>
                <input
                  required
                  minLength={10}
                  type="password"
                  value={resetPassword}
                  onChange={(e) => setResetPassword(e.target.value)}
                  className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-sm text-slate-900"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setResetTarget(null)}
                  className="px-3 py-2 text-xs font-semibold rounded-lg border border-slate-300 text-slate-700"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={busyId === resetTarget.id}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
                >
                  Save &amp; Revoke Sessions
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
