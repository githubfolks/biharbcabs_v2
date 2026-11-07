'use client';

import { useState, useEffect } from 'react';
import { MessageSquare, Send, User, Car, Phone, RefreshCw, Clock, ArrowLeft } from 'lucide-react';

export default function InboxPage() {
  const [threads, setThreads] = useState<any[]>([]);
  const [selectedPhone, setSelectedPhone] = useState<string | null>(null);
  const [activeThread, setActiveThread] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [replyText, setReplyText] = useState('');
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);

  async function loadThreads() {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/messages');
      const data = await res.json();
      if (data.success) {
        setThreads(data.threads || []);
        if (!selectedPhone && data.threads?.length > 0) {
          setSelectedPhone(data.threads[0].phone);
        }
      }
    } catch (err) {
      console.error('Failed to load WhatsApp threads:', err);
    } finally {
      setLoading(false);
    }
  }

  async function loadMessages(phone: string) {
    try {
      const res = await fetch(`/api/whatsapp/messages?phone=${phone}`);
      const data = await res.json();
      if (data.success) {
        setActiveThread(data.conversation);
        setMessages(data.messages || []);
      }
    } catch (err) {
      console.error('Failed to load message history:', err);
    }
  }

  useEffect(() => {
    loadThreads();
  }, []);

  useEffect(() => {
    if (selectedPhone) {
      loadMessages(selectedPhone);
    }
  }, [selectedPhone]);

  async function handleSendReply(e: React.FormEvent) {
    e.preventDefault();
    if (!selectedPhone || !replyText.trim()) return;

    setSending(true);
    try {
      const res = await fetch('/api/whatsapp/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: selectedPhone, text: replyText }),
      });
      const data = await res.json();
      if (data.success) {
        setReplyText('');
        loadMessages(selectedPhone);
      } else {
        alert(data.error || 'Failed to send WhatsApp message');
      }
    } catch (err: any) {
      alert('Error sending message: ' + err.message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight">Live WhatsApp Inbox</h1>
          <p className="text-sm text-slate-500">Real-time customer inquiries, driver broadcasts, and manual takeover</p>
        </div>
        <button
          onClick={() => {
            loadThreads();
            if (selectedPhone) loadMessages(selectedPhone);
          }}
          className="inline-flex items-center px-3 py-1.5 border border-slate-300 shadow-sm text-xs font-semibold rounded-md text-slate-700 bg-white hover:bg-slate-50"
        >
          <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden flex h-[720px]">
        {/* Left Sidebar: Threads List */}
        <div className="w-1/3 border-r border-slate-200 flex flex-col bg-slate-50/50">
          <div className="p-3 border-b border-slate-200 bg-white flex items-center justify-between">
            <span className="text-xs font-bold uppercase tracking-wider text-slate-600">Active Conversations</span>
            <span className="text-xs font-mono font-semibold px-2 py-0.5 bg-orange-100 text-orange-800 rounded-full">
              {threads.length}
            </span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
            {threads.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                No active WhatsApp conversations yet. Messages sent to +91 7070992170 will appear here.
              </div>
            ) : (
              threads.map((t) => {
                const isSelected = selectedPhone === t.phone;
                return (
                  <button
                    key={t.phone}
                    onClick={() => setSelectedPhone(t.phone)}
                    className={`w-full text-left p-3 transition flex items-start space-x-3 ${
                      isSelected ? 'bg-orange-50/80 border-l-4 border-orange-600' : 'hover:bg-slate-100/70'
                    }`}
                  >
                    <div className={`p-2 rounded-full mt-0.5 ${
                      t.role === 'DRIVER' ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'
                    }`}>
                      {t.role === 'DRIVER' ? <Car className="h-4 w-4" /> : <User className="h-4 w-4" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-900 text-sm truncate">
                          {t.customer_name || t.driver_name || `+${t.phone}`}
                        </span>
                        <span className="text-[10px] text-slate-400">
                          {new Date(t.last_message_at).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">
                        +{t.phone} &bull; <span className="uppercase text-[10px] font-semibold text-slate-600">[{t.role}]</span>
                      </div>
                      <div className="text-xs text-slate-400 truncate mt-1">
                        State: <span className="font-mono text-slate-600">{t.state}</span>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>

        {/* Right Pane: Chat Thread */}
        <div className="flex-1 flex flex-col bg-slate-100/40">
          {selectedPhone ? (
            <>
              {/* Chat Header */}
              <div className="p-3 bg-white border-b border-slate-200 flex items-center justify-between">
                <div className="flex items-center space-x-3">
                  <div className="bg-orange-100 text-orange-700 p-2 rounded-full">
                    <Phone className="h-4 w-4" />
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-900 text-sm">+{selectedPhone}</h3>
                    <div className="text-xs text-slate-500">
                      Role: <span className="font-semibold">{activeThread?.role || 'CUSTOMER'}</span> &bull; State:{' '}
                      <span className="font-mono">{activeThread?.state || 'IDLE'}</span>
                    </div>
                  </div>
                </div>
                <div className="text-xs text-slate-400 flex items-center">
                  <Clock className="h-3.5 w-3.5 mr-1" />
                  Live WhatsApp Cloud API
                </div>
              </div>

              {/* Chat Messages */}
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {messages.length === 0 ? (
                  <div className="h-full flex items-center justify-center text-xs text-slate-400">
                    No messages recorded for this conversation yet.
                  </div>
                ) : (
                  messages.map((m) => {
                    const isOutbound = m.direction === 'OUTBOUND';
                    let textBody = '';
                    if (m.payload?.text?.body) textBody = m.payload.text.body;
                    else if (m.payload?.interactive?.body?.text) textBody = m.payload.interactive.body.text;
                    else if (m.payload?.body) textBody = m.payload.body;
                    else if (typeof m.payload === 'string') textBody = m.payload;
                    else textBody = JSON.stringify(m.payload);

                    return (
                      <div
                        key={m.id}
                        className={`flex flex-col ${isOutbound ? 'items-end' : 'items-start'}`}
                      >
                        <div
                          className={`max-w-[75%] rounded-2xl p-3 shadow-sm text-sm ${
                            isOutbound
                              ? 'bg-emerald-600 text-white rounded-tr-none'
                              : 'bg-white border border-slate-200 text-slate-800 rounded-tl-none'
                          }`}
                        >
                          <div className="whitespace-pre-wrap">{textBody}</div>
                          {m.payload?.interactive?.action?.buttons && (
                            <div className="mt-2 pt-2 border-t border-emerald-500/40 flex flex-wrap gap-1">
                              {m.payload.interactive.action.buttons.map((b: any, idx: number) => (
                                <span key={idx} className="bg-emerald-700 text-white text-[10px] px-2 py-0.5 rounded">
                                  {b.reply?.title || b.title}
                                </span>
                              ))}
                            </div>
                          )}
                          <div
                            className={`text-[10px] mt-1 text-right ${
                              isOutbound ? 'text-emerald-100' : 'text-slate-400'
                            }`}
                          >
                            {new Date(m.created_at).toLocaleTimeString('en-IN', {
                              hour: '2-digit',
                              minute: '2-digit',
                            })}
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              {/* Chat Input */}
              <form onSubmit={handleSendReply} className="p-3 bg-white border-t border-slate-200 flex space-x-2">
                <input
                  type="text"
                  value={replyText}
                  onChange={(e) => setReplyText(e.target.value)}
                  placeholder="Type an official WhatsApp reply or price quote..."
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-orange-500"
                />
                <button
                  type="submit"
                  disabled={sending || !replyText.trim()}
                  className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-semibold hover:bg-orange-700 disabled:opacity-50 flex items-center"
                >
                  <Send className="h-4 w-4 mr-1" />
                  {sending ? 'Sending...' : 'Send'}
                </button>
              </form>
            </>
          ) : (
            <div className="h-full flex items-center justify-center text-slate-400 text-sm">
              Select a conversation to start reading or chatting
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

