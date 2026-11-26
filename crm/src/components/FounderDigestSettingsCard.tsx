'use client';

import { useState, useEffect } from 'react';
import { Bell, Send, Eye, Save, Sun, Moon } from 'lucide-react';

export default function FounderDigestSettingsCard({ canEdit }: { canEdit: boolean }) {
  const [enabled, setEnabled] = useState(true);
  const [phonesText, setPhonesText] = useState('');
  const [morningHour, setMorningHour] = useState(8);
  const [eveningHour, setEveningHour] = useState(20);
  const [lastMorning, setLastMorning] = useState<string | null>(null);
  const [lastEvening, setLastEvening] = useState<string | null>(null);
  const [resolvedRecipients, setResolvedRecipients] = useState<string[]>([]);
  const [previewSlot, setPreviewSlot] = useState<'MORNING' | 'EVENING'>('MORNING');
  const [previewMessage, setPreviewMessage] = useState<string>('');
  const [saving, setSaving] = useState(false);
  const [sending, setSending] = useState<'MORNING' | 'EVENING' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function loadDigest(slot: 'MORNING' | 'EVENING') {
    try {
      const res = await fetch(`/api/finance/founder-digest?slot=${slot}`, { cache: 'no-store' });
      const data = await res.json();
      if (data.success && data.config) {
        setEnabled(Boolean(data.config.enabled));
        setPhonesText((data.config.phones || []).join(', '));
        setMorningHour(Number(data.config.morning_hour_ist ?? 8));
        setEveningHour(Number(data.config.evening_hour_ist ?? 20));
        setLastMorning(data.config.last_morning_sent_date || null);
        setLastEvening(data.config.last_evening_sent_date || null);
        setResolvedRecipients(data.recipients || []);
        setPreviewMessage(data.message || '');
      }
    } catch {
      // ignore initial load error
    }
  }

  useEffect(() => {
    loadDigest(previewSlot);
  }, [previewSlot]);

  async function handleSave() {
    setSaving(true);
    setNotice(null);
    try {
      const phones = phonesText
        .split(',')
        .map((s) => s.replace(/\D/g, '').trim())
        .filter((s) => s.length >= 10);

      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: 'founder_whatsapp_digest',
          value: {
            enabled,
            phones,
            morning_hour_ist: morningHour,
            evening_hour_ist: eveningHour,
            last_morning_sent_date: lastMorning,
            last_evening_sent_date: lastEvening,
          },
        }),
      });
      const data = await res.json();
      if (data.success) {
        setNotice('Saved Founder WhatsApp Digest schedule.');
        await loadDigest(previewSlot);
      } else {
        setNotice(data.error || 'Could not save digest settings.');
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleSendNow(slot: 'MORNING' | 'EVENING') {
    setSending(slot);
    setNotice(null);
    try {
      const res = await fetch('/api/finance/founder-digest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slot }),
      });
      const data = await res.json();
      if (data.success) {
        setNotice(`Sent ${slot} digest to ${data.sent}/${data.recipients.length} recipient(s).`);
        setPreviewSlot(slot);
        setPreviewMessage(data.message || '');
      } else {
        setNotice(data.error || 'Failed to send digest.');
      }
    } finally {
      setSending(null);
    }
  }

  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-bold text-slate-900 uppercase tracking-wider flex items-center gap-2">
            <Bell className="h-4 w-4 text-orange-600" /> Founder WhatsApp Digest (8:00 AM &amp; 8:00 PM IST)
          </h2>
          <p className="text-xs text-slate-600 mt-0.5">
            Automatically sends a Morning recap (yesterday&apos;s P&amp;L + today&apos;s pickups) and an Evening summary (today&apos;s live rides, GMV, dues &amp; alerts) via the dispatch cron.
          </p>
        </div>
        <label className="inline-flex items-center gap-2 text-xs font-bold text-slate-800 cursor-pointer">
          <input
            type="checkbox"
            disabled={!canEdit}
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            className="rounded text-orange-600"
          />
          <span>Enabled</span>
        </label>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-slate-700">
            Founder WhatsApp Phone(s) (leave blank to use Admin Escalation Contacts)
          </label>
          <input
            disabled={!canEdit}
            value={phonesText}
            onChange={(e) => setPhonesText(e.target.value)}
            placeholder="919876543210, 919811112222"
            className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900"
          />
          <p className="text-[11px] text-slate-600 mt-1">
            Active recipients: <span className="font-mono">{resolvedRecipients.length > 0 ? resolvedRecipients.join(', ') : 'None configured'}</span>
          </p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700">Morning Hour (IST, 0–23)</label>
          <input
            type="number"
            min={0}
            max={23}
            disabled={!canEdit}
            value={morningHour}
            onChange={(e) => setMorningHour(Number(e.target.value))}
            className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900"
          />
          <p className="text-[11px] text-slate-600 mt-1">Last sent: {lastMorning || 'Never'}</p>
        </div>
        <div>
          <label className="block text-xs font-semibold text-slate-700">Evening Hour (IST, 0–23)</label>
          <input
            type="number"
            min={0}
            max={23}
            disabled={!canEdit}
            value={eveningHour}
            onChange={(e) => setEveningHour(Number(e.target.value))}
            className="w-full mt-1 px-3 py-2 border border-slate-300 rounded-md text-xs font-mono text-slate-900"
          />
          <p className="text-[11px] text-slate-600 mt-1">Last sent: {lastEvening || 'Never'}</p>
        </div>
      </div>

      {notice && (
        <div className="p-2.5 rounded-lg bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs font-semibold">
          {notice}
        </div>
      )}

      {/* Live Preview */}
      <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-bold text-slate-800">
            <Eye className="h-3.5 w-3.5 text-orange-600" /> Live WhatsApp Preview
          </div>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={() => setPreviewSlot('MORNING')}
              className={`inline-flex items-center px-2.5 py-1 rounded text-[11px] font-bold border ${
                previewSlot === 'MORNING' ? 'bg-orange-600 text-white border-orange-600' : 'bg-white text-slate-700 border-slate-300'
              }`}
            >
              <Sun className="h-3 w-3 mr-1" /> 8:00 AM Recap
            </button>
            <button
              type="button"
              onClick={() => setPreviewSlot('EVENING')}
              className={`inline-flex items-center px-2.5 py-1 rounded text-[11px] font-bold border ${
                previewSlot === 'EVENING' ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-700 border-slate-300'
              }`}
            >
              <Moon className="h-3 w-3 mr-1" /> 8:00 PM Summary
            </button>
          </div>
        </div>
        <pre className="whitespace-pre-wrap font-sans text-xs text-slate-800 bg-white p-3 rounded-md border border-slate-200 leading-relaxed">
          {previewMessage || 'Loading preview...'}
        </pre>
      </div>

      {canEdit && (
        <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-slate-200">
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={sending !== null}
              onClick={() => handleSendNow('MORNING')}
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5 mr-1.5 text-orange-600" />
              {sending === 'MORNING' ? 'Sending...' : 'Send 8 AM Digest Now'}
            </button>
            <button
              type="button"
              disabled={sending !== null}
              onClick={() => handleSendNow('EVENING')}
              className="inline-flex items-center px-3 py-1.5 rounded-lg text-xs font-semibold border border-slate-300 bg-white text-slate-800 hover:bg-slate-50 disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5 mr-1.5 text-indigo-600" />
              {sending === 'EVENING' ? 'Sending...' : 'Send 8 PM Digest Now'}
            </button>
          </div>
          <button
            type="button"
            disabled={saving}
            onClick={handleSave}
            className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-semibold bg-orange-600 text-white hover:bg-orange-700 disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5 mr-1.5" /> {saving ? 'Saving...' : 'Save Digest Settings'}
          </button>
        </div>
      )}
    </div>
  );
}
