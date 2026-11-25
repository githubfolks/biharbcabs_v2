'use client';

/**
 * Edit a driver's details, payout details and vehicles (migration 31). The API enforces permissions;
 * this only hides payout editing from roles without drivers.payout_details.
 */
import { useEffect, useState } from 'react';
import { Car, Pencil, RefreshCw, Trash2, X } from 'lucide-react';
import { hasPermission } from '@/lib/permissions';
import { REASON_MAX, REASON_MIN } from '@/lib/driver-status-rules';

export interface DynamicCabOption {
  id: number;
  code: string;
  category: string;
  display_name: string;
  fuel_type: string;
  is_active: boolean;
}

const DATE_FIELDS = [
  ['insurance_expiry', 'Insurance'],
  ['fitness_expiry', 'Fitness'],
  ['permit_expiry', 'Permit'],
] as const;

const ACTION_LABEL: Record<string, string> = {
  DRIVER_EDIT: 'Details changed',
  PAYOUT_DETAILS_EDIT: 'Payout details changed',
  VEHICLE_ADD: 'Vehicle added',
  VEHICLE_EDIT: 'Vehicle changed',
  VEHICLE_REMOVE: 'Vehicle removed',
  OFFERS_PAUSE: 'Ride offers paused',
  OFFERS_RESUME: 'Ride offers resumed',
};

const input = 'w-full mt-1 px-3 py-1.5 border rounded-md text-sm';
const label = 'block text-xs font-semibold text-slate-700';

type Msg = { kind: 'ok' | 'error'; text: string } | null;

function Message({ msg }: { msg: Msg }) {
  if (!msg) return null;
  return (
    <div className={`p-2 rounded text-xs border ${msg.kind === 'ok' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
      {msg.text}
    </div>
  );
}

function CategorySelect({
  value,
  options,
  onChange,
}: {
  value: string;
  options: DynamicCabOption[];
  onChange: (v: string) => void;
}) {
  const known = options.some((c) => c.code.toLowerCase() === String(value || '').toLowerCase());
  return (
    <select value={value} onChange={(e) => onChange(e.target.value)} className={input} required>
      {!value && <option value="">Select cab category &amp; fuel...</option>}
      {!known && value && <option value={value}>{value} (legacy)</option>}
      {options.map((c) => (
        <option key={c.code} value={c.code}>
          {c.display_name} [{c.category} / {c.fuel_type}]
        </option>
      ))}
    </select>
  );
}

const emptyVehicle = { registration_no: '', wp_vehicle_code: '', model_name: '', insurance_expiry: '', fitness_expiry: '', permit_expiry: '' };

async function send(url: string, method: string, body: any): Promise<{ ok: boolean; data: any }> {
  try {
    const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    return { ok: res.ok && data.success, data };
  } catch {
    return { ok: false, data: { error: 'Network error' } };
  }
}

export default function DriverEditDialog({
  driverId,
  role,
  onClose,
  onChanged,
}: {
  driverId: number;
  role: string | null;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [detail, setDetail] = useState<any | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [details, setDetails] = useState<any>({});
  const [payout, setPayout] = useState<any>({});
  const [vehicles, setVehicles] = useState<any[]>([]);
  const [cabOptions, setCabOptions] = useState<DynamicCabOption[]>([]);

  useEffect(() => {
    fetch('/api/catalog/cab-types')
      .then((res) => res.json())
      .then((data) => {
        if (data.success && Array.isArray(data.cabTypes)) {
          setCabOptions(data.cabTypes);
        }
      })
      .catch(() => {});
  }, []);
  const [newVehicle, setNewVehicle] = useState<any>(emptyVehicle);
  const [removing, setRemoving] = useState<{ id: number; reason: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msgs, setMsgs] = useState<Record<string, Msg>>({});
  const canPayout = hasPermission(role, 'drivers.payout_details');
  const setMsg = (key: string, msg: Msg) => setMsgs((m) => ({ ...m, [key]: msg }));

  async function load() {
    setLoadError(null);
    try {
      const res = await fetch(`/api/drivers/${driverId}`);
      const data = await res.json();
      if (!data.success) {
        setLoadError(data.error || 'Could not load driver');
        return;
      }
      setDetail(data);
      const d = data.driver;
      setDetails({
        full_name: d.full_name || '',
        phone: d.phone || '',
        whatsapp_phone: d.whatsapp_phone || '',
        base_city: d.base_city || '',
        license_number: d.license_number || '',
        license_expiry: d.license_expiry || '',
      });
      setPayout({ bank_upi_id: d.bank_upi_id || '', bank_account_number: d.bank_account_number || '', bank_ifsc: d.bank_ifsc || '' });
      setVehicles(data.vehicles.map((v: any) => ({ ...v, insurance_expiry: v.insurance_expiry || '', fitness_expiry: v.fitness_expiry || '', permit_expiry: v.permit_expiry || '' })));
    } catch {
      setLoadError('Could not load driver: network error');
    }
  }

  useEffect(() => {
    load();
  }, [driverId]);

  async function run(key: string, url: string, method: string, body: any, done: string) {
    setBusy(key);
    setMsg(key, null);
    const { ok, data } = await send(url, method, body);
    setBusy(null);
    if (!ok) {
      setMsg(key, { kind: 'error', text: data.error || 'Not saved' });
      return false;
    }
    const nothing = Array.isArray(data.changed) && data.changed.length === 0;
    setMsg(key, { kind: 'ok', text: nothing ? 'Nothing changed' : done });
    await load();
    if (!nothing) onChanged();
    return true;
  }

  const saveDetails = (e: React.FormEvent) => {
    e.preventDefault();
    run('details', `/api/drivers/${driverId}`, 'PATCH', details, 'Details saved');
  };
  const savePayout = (e: React.FormEvent) => {
    e.preventDefault();
    run('payout', `/api/drivers/${driverId}/payout-details`, 'PATCH', payout, 'Payout details saved');
  };
  const saveVehicle = (v: any) =>
    run(`v${v.id}`, `/api/drivers/${driverId}/vehicles/${v.id}`, 'PATCH', {
      wp_vehicle_code: v.wp_vehicle_code,
      model_name: v.model_name,
      insurance_expiry: v.insurance_expiry,
      fitness_expiry: v.fitness_expiry,
      permit_expiry: v.permit_expiry,
    }, 'Vehicle saved');
  const confirmRemove = async () => {
    if (!removing) return;
    const ok = await run(`v${removing.id}`, `/api/drivers/${driverId}/vehicles/${removing.id}`, 'DELETE', { reason: removing.reason }, 'Vehicle removed');
    if (ok) setRemoving(null);
  };
  const addVehicle = async (e: React.FormEvent) => {
    e.preventDefault();
    const ok = await run('add', `/api/drivers/${driverId}/vehicles`, 'POST', newVehicle, 'Vehicle added and verified');
    if (ok) setNewVehicle(emptyVehicle);
  };
  const setVehicle = (id: number, field: string, value: string) =>
    setVehicles((vs) => vs.map((v) => (v.id === id ? { ...v, [field]: value } : v)));

  const mask = (v: string | null) => (v ? `•••• ${String(v).slice(-4)}` : '—');

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-2xl max-w-3xl w-full max-h-[90vh] flex flex-col overflow-hidden">
        <div className="shrink-0 flex justify-between items-center border-b px-5 py-4 bg-white">
          <h3 className="text-lg font-bold text-slate-900 flex items-center">
            <Pencil className="h-5 w-5 mr-1.5 text-orange-600" />
            Edit Driver{detail ? `: ${detail.driver.full_name}` : ''}
          </h3>
          <button onClick={onClose} className="p-1.5 rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto p-5 space-y-5 flex-1">

        {loadError ? (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded text-sm text-rose-700">{loadError}</div>
        ) : !detail ? (
          <div className="py-10 flex justify-center items-center text-slate-600 text-sm">
            <RefreshCw className="h-5 w-5 animate-spin mr-2" /> Loading driver...
          </div>
        ) : (
          <>
            {/* Details */}
            <form onSubmit={saveDetails} className="space-y-3">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Driver details</h4>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {([
                  ['full_name', 'Full name', 'text'],
                  ['base_city', 'Base / hub city', 'text'],
                  ['phone', 'Primary phone (with country code)', 'text'],
                  ['whatsapp_phone', 'WhatsApp phone (with country code)', 'text'],
                  ['license_number', 'Driving licence number', 'text'],
                  ['license_expiry', 'Licence valid until', 'date'],
                ] as const).map(([field, text, type]) => (
                  <div key={field}>
                    <label className={label}>{text}</label>
                    <input
                      type={type}
                      required={field !== 'license_number'}
                      value={details[field]}
                      onChange={(e) => setDetails({ ...details, [field]: e.target.value })}
                      className={input}
                    />
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-slate-500">
                Changing the phone changes which WhatsApp number the driver is recognised by. A past licence date suspends the driver at the next expiry check.
              </p>
              <Message msg={msgs.details} />
              <div className="flex justify-end">
                <button type="submit" disabled={busy === 'details'} className="px-4 py-2 bg-orange-600 text-white rounded-md text-xs font-bold hover:bg-orange-700 disabled:opacity-50">
                  {busy === 'details' ? 'Saving...' : 'Save details'}
                </button>
              </div>
            </form>

            {/* Payout details */}
            <div className="border-t pt-4 space-y-3">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Payout details</h4>
              {canPayout ? (
                <form onSubmit={savePayout} className="space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    {([
                      ['bank_upi_id', 'UPI ID'],
                      ['bank_account_number', 'Bank account number'],
                      ['bank_ifsc', 'IFSC'],
                    ] as const).map(([field, text]) => (
                      <div key={field}>
                        <label className={label}>{text}</label>
                        <input
                          type="text"
                          value={payout[field]}
                          onChange={(e) => setPayout({ ...payout, [field]: e.target.value })}
                          className={input}
                        />
                      </div>
                    ))}
                  </div>
                  <p className="text-[11px] text-slate-500">Leave a field empty to clear it. Every change is recorded with your name.</p>
                  <Message msg={msgs.payout} />
                  <div className="flex justify-end">
                    <button type="submit" disabled={busy === 'payout'} className="px-4 py-2 bg-emerald-600 text-white rounded-md text-xs font-bold hover:bg-emerald-700 disabled:opacity-50">
                      {busy === 'payout' ? 'Saving...' : 'Save payout details'}
                    </button>
                  </div>
                </form>
              ) : (
                <div className="text-xs text-slate-600 space-y-1">
                  <div>UPI ID: {detail.driver.bank_upi_id || '—'}</div>
                  <div>Bank account: {mask(detail.driver.bank_account_number)} &bull; IFSC: {detail.driver.bank_ifsc || '—'}</div>
                  <p className="text-[11px] text-slate-500">Only super admin and finance can change payout details.</p>
                </div>
              )}
            </div>

            {/* Vehicles */}
            <div className="border-t pt-4 space-y-3">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider">Vehicles</h4>
              {vehicles.length === 0 && <p className="text-xs text-slate-500 italic">No vehicles. The driver gets no rides until one is added.</p>}
              {vehicles.map((v) => (
                <div key={v.id} className="p-3 border border-slate-200 rounded-lg space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="text-sm font-semibold text-slate-900 flex items-center">
                      <Car className="h-4 w-4 mr-1 text-slate-500" />
                      {v.registration_no}
                      <span className={`ml-2 text-[10px] px-1.5 py-0.5 rounded font-semibold ${v.is_verified ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>
                        {v.is_verified ? 'VERIFIED' : 'NOT VERIFIED'}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => setRemoving({ id: v.id, reason: '' })}
                      className="inline-flex items-center text-[11px] text-rose-600 hover:text-rose-800 font-semibold"
                    >
                      <Trash2 className="h-3 w-3 mr-1" /> Remove
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <div>
                      <label className={label}>Category</label>
                      <CategorySelect value={v.wp_vehicle_code} options={cabOptions} onChange={(val) => setVehicle(v.id, 'wp_vehicle_code', val)} />
                    </div>
                    <div>
                      <label className={label}>Model</label>
                      <input type="text" value={v.model_name} onChange={(e) => setVehicle(v.id, 'model_name', e.target.value)} className={input} />
                    </div>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                    {DATE_FIELDS.map(([field, text]) => (
                      <div key={field}>
                        <label className={label}>{text} valid until</label>
                        <input type="date" value={v[field]} onChange={(e) => setVehicle(v.id, field, e.target.value)} className={input} />
                      </div>
                    ))}
                  </div>
                  {removing?.id === v.id && (
                    <div className="p-2 bg-rose-50 border border-rose-200 rounded space-y-2">
                      <label className={label}>Why is this vehicle being removed? (kept for ride history)</label>
                      <textarea
                        rows={2}
                        minLength={REASON_MIN}
                        maxLength={REASON_MAX}
                        value={removing?.reason ?? ''}
                        onChange={(e) => setRemoving({ id: v.id, reason: e.target.value })}
                        placeholder="e.g. Driver sold this car"
                        className="w-full px-2 py-1 border rounded text-xs"
                      />
                      <div className="flex justify-end gap-2">
                        <button type="button" onClick={() => setRemoving(null)} className="px-2 py-1 text-[11px] text-slate-600">Cancel</button>
                        <button
                          type="button"
                          onClick={confirmRemove}
                          disabled={busy === `v${v.id}` || (removing?.reason ?? '').trim().length < REASON_MIN}
                          className="px-3 py-1 bg-rose-600 text-white rounded text-[11px] font-semibold hover:bg-rose-700 disabled:opacity-50"
                        >
                          Confirm remove
                        </button>
                      </div>
                    </div>
                  )}
                  <Message msg={msgs[`v${v.id}`]} />
                  <div className="flex justify-end">
                    <button
                      type="button"
                      onClick={() => saveVehicle(v)}
                      disabled={busy === `v${v.id}`}
                      className="px-3 py-1.5 bg-slate-900 text-white rounded-md text-xs font-bold hover:bg-slate-800 disabled:opacity-50"
                    >
                      {busy === `v${v.id}` ? 'Saving...' : 'Save vehicle'}
                    </button>
                  </div>
                </div>
              ))}

              <form onSubmit={addVehicle} className="p-3 border border-dashed border-slate-300 rounded-lg space-y-2">
                <div className="text-xs font-semibold text-slate-700">Add a vehicle</div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div>
                    <label className={label}>Registration number</label>
                    <input
                      type="text"
                      required
                      value={newVehicle.registration_no}
                      onChange={(e) => setNewVehicle({ ...newVehicle, registration_no: e.target.value })}
                      placeholder="e.g. BR-01-PK-9821"
                      className={input}
                    />
                  </div>
                  <div>
                    <label className={label}>Category</label>
                    <CategorySelect value={newVehicle.wp_vehicle_code} options={cabOptions} onChange={(val) => setNewVehicle({ ...newVehicle, wp_vehicle_code: val })} />
                  </div>
                  <div>
                    <label className={label}>Model</label>
                    <input
                      type="text"
                      required
                      value={newVehicle.model_name}
                      onChange={(e) => setNewVehicle({ ...newVehicle, model_name: e.target.value })}
                      placeholder="e.g. Maruti Suzuki Dzire"
                      className={input}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {DATE_FIELDS.map(([field, text]) => (
                    <div key={field}>
                      <label className={label}>{text} valid until</label>
                      <input
                        type="date"
                        required
                        value={newVehicle[field]}
                        onChange={(e) => setNewVehicle({ ...newVehicle, [field]: e.target.value })}
                        className={input}
                      />
                    </div>
                  ))}
                </div>
                <p className="text-[11px] text-slate-500">Check the documents before adding: the vehicle is verified at once and can get rides.</p>
                <Message msg={msgs.add} />
                <div className="flex justify-end">
                  <button type="submit" disabled={busy === 'add'} className="px-3 py-1.5 bg-orange-600 text-white rounded-md text-xs font-bold hover:bg-orange-700 disabled:opacity-50">
                    {busy === 'add' ? 'Adding...' : 'Add vehicle'}
                  </button>
                </div>
              </form>
            </div>

            {/* History */}
            <div className="border-t pt-4">
              <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Change history</h4>
              {detail.edits.length === 0 ? (
                <p className="text-xs text-slate-600 italic">No edits recorded.</p>
              ) : (
                <ul className="space-y-1.5 max-h-56 overflow-y-auto text-xs">
                  {detail.edits.map((e: any) => (
                    <li key={e.id} className="p-2 bg-slate-50 border border-slate-200 rounded break-words">
                      <span className="font-semibold">{ACTION_LABEL[e.action] || e.action}</span>
                      {e.registration_no && <span> ({e.registration_no})</span>}
                      <span className="text-slate-500">
                        {' '}by {e.changed_by_name},{' '}
                        {new Date(e.created_at).toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                      </span>
                      <div className="text-slate-600">
                        {Object.entries(e.changes as Record<string, { from: string | null; to: string | null }>)
                          .map(([f, c]) => `${f}: ${c.from ?? '—'} → ${c.to ?? '—'}`)
                          .join('; ')}
                      </div>
                      {e.reason && <div className="text-slate-600 italic">&quot;{e.reason}&quot;</div>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </>
        )}
        </div>
      </div>
    </div>
  );
}
