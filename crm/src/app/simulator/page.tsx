'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import {
  Smartphone, Send, RefreshCw, User, Car, History, RotateCcw,
  CheckCircle2, AlertCircle, List, MessageSquare,
} from 'lucide-react';
import BookingTimelineDrawer from '@/components/BookingTimelineDrawer';

interface WaLogMessage {
  id: number;
  direction: 'INBOUND' | 'OUTBOUND';
  phone: string;
  message_type: string;
  payload: any;
  status: string;
  error_message?: string | null;
  created_at: string;
}

interface InteractiveButton {
  id: string;
  title: string;
}

interface InteractiveListSection {
  title?: string;
  rows: Array<{ id: string; title: string; description?: string }>;
}

function parseWaPayload(msg: WaLogMessage, bookingIdByCode: Map<string, number>): {
  header?: string;
  body: string;
  footer?: string;
  buttons: InteractiveButton[];
  sections: InteractiveListSection[];
  listButtonLabel?: string;
} {
  const p = msg.payload || {};

  // Inbound simulated interactive tap
  if (msg.direction === 'INBOUND') {
    const btnReply = p?.interactive?.button_reply;
    const listReply = p?.interactive?.list_reply;
    if (btnReply?.title || btnReply?.id) {
      return { body: btnReply.title || btnReply.id, buttons: [], sections: [] };
    }
    if (listReply?.title || listReply?.id) {
      return { body: listReply.title || listReply.id, buttons: [], sections: [] };
    }
    const textBody = typeof p?.text === 'string' ? p.text : p?.text?.body;
    return { body: textBody || '[Message]', buttons: [], sections: [] };
  }

  // Outbound interactive button or list
  if (p?.type === 'interactive' && p?.interactive) {
    const inter = p.interactive;
    const header = inter?.header?.text;
    const body = inter?.body?.text || '';
    const footer = inter?.footer?.text;

    if (inter.type === 'button' && Array.isArray(inter?.action?.buttons)) {
      const buttons: InteractiveButton[] = inter.action.buttons
        .map((b: any) => ({
          id: b?.reply?.id || b?.id || '',
          title: b?.reply?.title || b?.title || '',
        }))
        .filter((b: InteractiveButton) => b.id && b.title);
      return { header, body, footer, buttons, sections: [] };
    }

    if (inter.type === 'list' && Array.isArray(inter?.action?.sections)) {
      const sections: InteractiveListSection[] = inter.action.sections.map((s: any) => ({
        title: s.title,
        rows: Array.isArray(s.rows)
          ? s.rows.map((r: any) => ({ id: r.id, title: r.title, description: r.description }))
          : [],
      }));
      return {
        header,
        body,
        footer,
        buttons: [],
        sections,
        listButtonLabel: inter?.action?.button || 'Choose option',
      };
    }
  }

  // Outbound template message (attach the template's quick-reply buttons so they can be tapped in Simulator)
  if (p?.type === 'template' && p?.template) {
    const tplName = String(p.template.name || 'template');
    const comps = Array.isArray(p.template.components) ? p.template.components : [];
    const params = comps
      .filter((c: any) => c.type === 'body')
      .flatMap((c: any) => (Array.isArray(c.parameters) ? c.parameters.map((pr: any) => String(pr.text || '')) : []));

    const codeMatch = params.join(' ').match(/#?(BC-[A-Z0-9]+)/i);
    const matchedBookingId = codeMatch ? bookingIdByCode.get(codeMatch[1].toUpperCase()) : undefined;
    const buttons: InteractiveButton[] = [];
    if (matchedBookingId) {
      if (tplName.includes('driver_ride_alert')) {
        buttons.push(
          { id: `accept_ride_${matchedBookingId}`, title: '✅ Accept Ride' },
          { id: `decline_ride_${matchedBookingId}`, title: '❌ Decline' }
        );
      } else if (tplName.includes('driver_trip_assigned')) {
        buttons.push({ id: `start_trip_${matchedBookingId}`, title: '🚀 Start Trip' });
      } else if (tplName.includes('driver_wakeup')) {
        buttons.push({ id: `wakeup_ready_${matchedBookingId}`, title: '⏰ I Am Ready & On Time' });
      }
    }

    return {
      header: `Template: ${tplName}`,
      body: params.length > 0 ? params.join(' • ') : `Sent template "${tplName}"`,
      buttons,
      sections: [],
    };
  }

  // Outbound document
  if (p?.type === 'document' && p?.document) {
    return {
      header: p.document.filename || 'Document',
      body: p.document.caption || p.document.link || 'PDF document sent',
      buttons: [],
      sections: [],
    };
  }

  // Standard text
  const textBody = typeof p?.text === 'string' ? p.text : p?.text?.body;
  return { body: textBody || JSON.stringify(p), buttons: [], sections: [] };
}

function formatTime(ts: string): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString('en-IN', {
    timeZone: 'Asia/Kolkata',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

export default function WhatsAppSimulatorPage() {
  const [persona, setPersona] = useState<'CUSTOMER' | 'DRIVER'>('CUSTOMER');
  const [customerPhone, setCustomerPhone] = useState('919876543210');
  const [customerName, setCustomerName] = useState('Test Customer');
  const [drivers, setDrivers] = useState<any[]>([]);
  const [selectedDriverPhone, setSelectedDriverPhone] = useState('');
  const [bookings, setBookings] = useState<any[]>([]);

  const [messages, setMessages] = useState<WaLogMessage[]>([]);
  const [conversation, setConversation] = useState<any | null>(null);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [loadingChat, setLoadingChat] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timelineBookingId, setTimelineBookingId] = useState<number | null>(null);

  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const activePhone = (persona === 'DRIVER' ? selectedDriverPhone : customerPhone).replace(/\D/g, '');
  const activeDriver = drivers.find(
    (d) => String(d.whatsapp_phone || d.phone || '').replace(/\D/g, '') === activePhone
  );

  const loadDriversAndBookings = useCallback(async () => {
    try {
      const [drvRes, bkRes] = await Promise.all([
        fetch('/api/drivers', { cache: 'no-store' }),
        fetch('/api/bookings', { cache: 'no-store' }),
      ]);
      const drvData = await drvRes.json().catch(() => null);
      const bkData = await bkRes.json().catch(() => null);

      if (drvData?.success && Array.isArray(drvData.drivers)) {
        setDrivers(drvData.drivers);
        if (!selectedDriverPhone && drvData.drivers.length > 0) {
          const first = drvData.drivers.find((d: any) => d.onboarding_status === 'APPROVED_ACTIVE') || drvData.drivers[0];
          const p = String(first.whatsapp_phone || first.phone || '').replace(/\D/g, '');
          if (p) setSelectedDriverPhone(p);
        }
      }
      if (bkData?.success && Array.isArray(bkData.bookings)) {
        setBookings(bkData.bookings.slice(0, 50));
      }
    } catch (err) {
      console.error('Failed to load drivers/bookings:', err);
    }
  }, [selectedDriverPhone]);

  const loadChat = useCallback(async (phone: string) => {
    const clean = phone.replace(/\D/g, '');
    if (clean.length < 10) {
      setMessages([]);
      setConversation(null);
      return;
    }
    setLoadingChat(true);
    setError(null);
    try {
      const res = await fetch(`/api/whatsapp/messages?phone=${encodeURIComponent(clean)}`, { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || 'Could not load chat history');
      } else {
        setConversation(data.conversation || null);
        setMessages(data.messages || []);
      }
    } catch {
      setError('Network error while loading chat history');
    } finally {
      setLoadingChat(false);
    }
  }, []);

  useEffect(() => {
    loadDriversAndBookings();
  }, [loadDriversAndBookings]);

  useEffect(() => {
    if (activePhone.length >= 10) {
      loadChat(activePhone);
    }
  }, [activePhone, loadChat]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  async function sendSimulated(payload: { text?: string; buttonId?: string; buttonText?: string }) {
    if (activePhone.length < 10) {
      setError('Enter a valid phone number (at least 10 digits with country code, e.g. 919876543210).');
      return;
    }
    setSending(true);
    setError(null);
    try {
      const res = await fetch('/api/whatsapp/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          phone: activePhone,
          customerName: persona === 'CUSTOMER' ? customerName : activeDriver?.full_name,
          ...payload,
        }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data?.success) {
        setError(data?.error || `Simulation failed (HTTP ${res.status})`);
      } else {
        setConversation(data.conversation || null);
        setMessages(data.messages || []);
        setInputText('');
        // Refresh live bookings so newly created/assigned/started/completed rides show immediately
        loadDriversAndBookings();
      }
    } catch (err: any) {
      setError(err?.message || 'Network error while simulating WhatsApp message');
    } finally {
      setSending(false);
    }
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!inputText.trim() || sending) return;
    sendSimulated({ text: inputText.trim() });
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
            <Smartphone className="h-6 w-6 text-emerald-600" />
            WhatsApp Flow Simulator
          </h1>
          <p className="text-sm text-slate-500">
            End-to-end customer &amp; driver WhatsApp testing powered by the live CRM booking, dispatch, OTP, billing, and timeline APIs
          </p>
        </div>
        <button
          onClick={() => {
            loadDriversAndBookings();
            if (activePhone.length >= 10) loadChat(activePhone);
          }}
          className="inline-flex items-center px-3 py-1.5 border border-slate-300 shadow-sm text-xs font-semibold rounded-md text-slate-700 bg-white hover:bg-slate-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loadingChat ? 'animate-spin' : ''}`} />
          Refresh All
        </button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Left Column: Persona Switcher + Live Bookings */}
        <div className="lg:col-span-5 space-y-4">
          {/* Persona Card */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-4">
            <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-lg">
              <button
                type="button"
                onClick={() => setPersona('CUSTOMER')}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-bold transition ${
                  persona === 'CUSTOMER'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <User className="h-3.5 w-3.5 text-orange-600" />
                Customer Phone
              </button>
              <button
                type="button"
                onClick={() => setPersona('DRIVER')}
                className={`flex items-center justify-center gap-1.5 py-2 rounded-md text-xs font-bold transition ${
                  persona === 'DRIVER'
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <Car className="h-3.5 w-3.5 text-blue-600" />
                Driver Phone
              </button>
            </div>

            {persona === 'CUSTOMER' ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Customer Phone (with 91)
                  </label>
                  <input
                    type="text"
                    value={customerPhone}
                    onChange={(e) => setCustomerPhone(e.target.value)}
                    placeholder="919876543210"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md font-mono text-slate-900"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                    Customer Name
                  </label>
                  <input
                    type="text"
                    value={customerName}
                    onChange={(e) => setCustomerName(e.target.value)}
                    placeholder="Test Customer"
                    className="w-full px-3 py-1.5 text-sm border border-slate-300 rounded-md text-slate-900"
                  />
                </div>
              </div>
            ) : (
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">
                  Select Registered Driver (from /api/drivers)
                </label>
                <select
                  value={selectedDriverPhone}
                  onChange={(e) => setSelectedDriverPhone(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-md bg-white text-slate-900"
                >
                  {drivers.length === 0 && <option value="">No drivers found</option>}
                  {drivers.map((d) => {
                    const ph = String(d.whatsapp_phone || d.phone || '').replace(/\D/g, '');
                    return (
                      <option key={d.id} value={ph}>
                        #{d.id} {d.full_name} ({d.base_city || 'No city'}) • {ph} — {d.onboarding_status}
                      </option>
                    );
                  })}
                </select>
              </div>
            )}

            {/* Quick Commands */}
            <div>
              <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1.5">
                Quick Triggers
              </div>
              <div className="flex flex-wrap gap-1.5">
                {persona === 'CUSTOMER' ? (
                  <>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => sendSimulated({ text: 'Hi' })}
                      className="px-2.5 py-1 text-xs font-semibold rounded-md bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100"
                    >
                      Send &ldquo;Hi&rdquo;
                    </button>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => sendSimulated({ text: 'OTP' })}
                      className="px-2.5 py-1 text-xs font-semibold rounded-md bg-indigo-50 text-indigo-800 border border-indigo-200 hover:bg-indigo-100"
                    >
                      Request &ldquo;OTP&rdquo;
                    </button>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => sendSimulated({ text: 'menu' })}
                      className="inline-flex items-center px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200"
                    >
                      <RotateCcw className="h-3 w-3 mr-1" />
                      Main Menu
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => sendSimulated({ text: 'Ready' })}
                      className="px-2.5 py-1 text-xs font-semibold rounded-md bg-cyan-50 text-cyan-800 border border-cyan-200 hover:bg-cyan-100"
                    >
                      Wake-up &ldquo;Ready&rdquo;
                    </button>
                    <button
                      type="button"
                      disabled={sending}
                      onClick={() => sendSimulated({ text: 'Hi' })}
                      className="px-2.5 py-1 text-xs font-semibold rounded-md bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200"
                    >
                      Send &ldquo;Hi&rdquo;
                    </button>
                  </>
                )}
              </div>
            </div>

            {conversation && (
              <div className="text-[11px] bg-slate-50 border border-slate-200 rounded-md px-3 py-2 flex items-center justify-between">
                <span className="text-slate-500">Bot State:</span>
                <span className="font-mono font-bold text-slate-800">{conversation.state || 'IDLE'}</span>
              </div>
            )}
          </div>

          {/* Live Bookings Feed (from /api/bookings) */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <span className="text-xs font-bold uppercase tracking-wider text-slate-600">
                Live Bookings (/api/bookings)
              </span>
              <span className="text-[11px] text-slate-600">Latest {bookings.length}</span>
            </div>
            <div className="divide-y divide-slate-100 max-h-[360px] overflow-y-auto">
              {bookings.length === 0 ? (
                <div className="p-4 text-xs text-slate-600 text-center">No bookings yet.</div>
              ) : (
                bookings.map((b) => (
                  <div key={b.id} className="px-4 py-2.5 flex items-center justify-between gap-2 text-xs hover:bg-slate-50">
                    <div className="min-w-0">
                      <div className="font-mono font-bold text-slate-900 flex items-center gap-1.5">
                        #{b.booking_code}
                        <span className="font-sans text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-700">
                          {String(b.booking_status).replace(/_/g, ' ')}
                        </span>
                      </div>
                      <div className="text-slate-600 truncate mt-0.5">
                        {b.origin_city} → {b.destination_city || 'Local'} • ₹{Number(b.customer_total_fare).toLocaleString('en-IN')}
                      </div>
                      <div className="text-[10px] text-slate-600">
                        {b.customer_phone} {b.driver_name ? `• Driver: ${b.driver_name}` : '• Unassigned'}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setTimelineBookingId(Number(b.id))}
                      className="shrink-0 inline-flex items-center px-2 py-1 border border-slate-300 rounded text-[11px] font-semibold text-slate-700 bg-white hover:bg-slate-50"
                    >
                      <History className="h-3 w-3 mr-1" />
                      Timeline
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Right Column: Interactive WhatsApp Phone Chat */}
        <div className="lg:col-span-7 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col h-[calc(100dvh-11rem)] min-h-[520px] max-h-[760px] overflow-hidden">
          {/* Phone Header */}
          <div className="px-4 py-3 bg-emerald-700 text-white flex items-center justify-between shrink-0">
            <div className="flex items-center gap-2.5">
              <div className="h-9 w-9 rounded-full bg-emerald-600 border border-emerald-400/50 flex items-center justify-center font-bold text-sm">
                BC
              </div>
              <div>
                <div className="text-sm font-bold leading-tight">BiharCabs WhatsApp Bot</div>
                <div className="text-[11px] text-emerald-100 font-mono">
                  Acting as {persona}: {activePhone || '—'}
                </div>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wider bg-emerald-800/80 px-2 py-1 rounded-full">
              <CheckCircle2 className="h-3 w-3 text-emerald-300" />
              Live API Mode
            </span>
          </div>

          {error && (
            <div className="px-4 py-2 bg-rose-50 border-b border-rose-200 text-rose-700 text-xs flex items-center gap-1.5 shrink-0">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              {error}
            </div>
          )}

          {/* Chat Thread */}
          <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#efeae2]">
            {messages.length === 0 ? (
              <div className="h-full flex flex-col items-center justify-center text-center text-slate-500 p-6">
                <MessageSquare className="h-10 w-10 text-slate-600 mb-2" />
                <div className="text-sm font-semibold text-slate-700">No messages yet for {activePhone || 'this number'}</div>
                <p className="text-xs text-slate-500 mt-1 max-w-sm">
                  Click <strong>Send &ldquo;Hi&rdquo;</strong> or type a message below to start the real BiharCabs WhatsApp flow.
                </p>
              </div>
            ) : (
              (() => {
                const bookingIdByCode = new Map<string, number>();
                bookings.forEach((b) => {
                  if (b.booking_code) bookingIdByCode.set(String(b.booking_code).toUpperCase(), Number(b.id));
                });
                return messages.map((msg) => {
                const parsed = parseWaPayload(msg, bookingIdByCode);
                const isUser = msg.direction === 'INBOUND';
                return (
                  <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[85%] rounded-xl px-3.5 py-2.5 shadow-2xs text-sm ${
                        isUser
                          ? 'bg-emerald-600 text-white rounded-tr-none'
                          : 'bg-white text-slate-900 border border-slate-200/80 rounded-tl-none'
                      }`}
                    >
                      {parsed.header && (
                        <div className={`text-xs font-bold mb-1 ${isUser ? 'text-emerald-100' : 'text-slate-900'}`}>
                          {parsed.header}
                        </div>
                      )}
                      <div className="whitespace-pre-wrap break-words leading-relaxed text-[13px]">
                        {parsed.body}
                      </div>
                      {parsed.footer && (
                        <div className={`text-[11px] mt-1 ${isUser ? 'text-emerald-100' : 'text-slate-600'}`}>
                          {parsed.footer}
                        </div>
                      )}

                      {/* Clickable Quick-Reply Buttons */}
                      {!isUser && parsed.buttons.length > 0 && (
                        <div className="mt-2.5 pt-2 border-t border-slate-100 flex flex-wrap gap-1.5">
                          {parsed.buttons.map((btn) => (
                            <button
                              key={btn.id}
                              type="button"
                              disabled={sending}
                              onClick={() => sendSimulated({ buttonId: btn.id, buttonText: btn.title })}
                              className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200 hover:bg-emerald-100 disabled:opacity-50 transition"
                            >
                              {btn.title}
                            </button>
                          ))}
                        </div>
                      )}

                      {/* Clickable Interactive List Options */}
                      {!isUser && parsed.sections.length > 0 && (
                        <div className="mt-2.5 pt-2 border-t border-slate-100 space-y-2">
                          <div className="text-[11px] font-bold text-emerald-700 flex items-center gap-1">
                            <List className="h-3.5 w-3.5" />
                            {parsed.listButtonLabel || 'Select an option'}
                          </div>
                          {parsed.sections.map((sec, idx) => (
                            <div key={idx} className="space-y-1">
                              {sec.title && (
                                <div className="text-[10px] font-bold uppercase tracking-wider text-slate-600">
                                  {sec.title}
                                </div>
                              )}
                              {sec.rows.map((row) => (
                                <button
                                  key={row.id}
                                  type="button"
                                  disabled={sending}
                                  onClick={() => sendSimulated({ buttonId: row.id, buttonText: row.title })}
                                  className="w-full text-left px-2.5 py-1.5 rounded-lg bg-slate-50 hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 transition disabled:opacity-50"
                                >
                                  <div className="text-xs font-semibold text-slate-900">{row.title}</div>
                                  {row.description && (
                                    <div className="text-[11px] text-slate-500">{row.description}</div>
                                  )}
                                </button>
                              ))}
                            </div>
                          ))}
                        </div>
                      )}

                      <div className={`text-[10px] mt-1 text-right ${isUser ? 'text-emerald-100' : 'text-slate-600'}`}>
                        {formatTime(msg.created_at)}
                      </div>
                    </div>
                  </div>
                );
              });
              })()
            )}
            <div ref={chatEndRef} />
          </div>

          {/* Message Input */}
          <form onSubmit={handleSubmit} className="p-3 bg-slate-50 border-t border-slate-200 flex gap-2 shrink-0">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              disabled={sending}
              placeholder={
                persona === 'CUSTOMER'
                  ? 'Type customer message (e.g. Hi, Patna Junction, tomorrow 10am)...'
                  : 'Type driver reply (e.g. Ready, OTP 4-digit code, closing KM)...'
              }
              className="flex-1 px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            />
            <button
              type="submit"
              disabled={sending || !inputText.trim()}
              className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              <Send className="h-4 w-4 mr-1.5" />
              {sending ? 'Sending…' : 'Send'}
            </button>
          </form>
        </div>
      </div>

      {timelineBookingId !== null && (
        <BookingTimelineDrawer
          bookingId={timelineBookingId}
          canManage={true}
          onClose={() => setTimelineBookingId(null)}
          onUpdated={loadDriversAndBookings}
        />
      )}
    </div>
  );
}
