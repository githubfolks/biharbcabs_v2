'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  Car, MessageSquare, Users, Wallet, Sliders, LogOut, User, Database, ChevronRight, Menu, X, Package, PlusCircle, Smartphone, ShieldCheck, ClipboardList, UserCheck,
} from 'lucide-react';
import { Permission, hasPermission } from '@/lib/permissions';

interface SystemStatusView {
  database: { ok: boolean };
  whatsapp: { state: 'OK' | 'FAILING' | 'NOT_CONFIGURED' | 'UNKNOWN'; lastSentAt: string | null; failedLastHour: number; sentLastHour: number; countsCapped: boolean };
}

const STATUS_REFRESH_MS = 60_000;
const timeText = (iso: string) =>
  new Date(iso).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

type Pill = { label: string; title: string; dot: string; icon: string; chip: string };
const GREY: Omit<Pill, 'label' | 'title'> = { dot: 'bg-slate-500', icon: 'text-slate-600', chip: 'text-slate-700 bg-slate-50 border-slate-200' };
const GREEN: Omit<Pill, 'label' | 'title'> = { dot: 'bg-emerald-500', icon: 'text-emerald-400', chip: 'text-slate-600 bg-slate-50 border-slate-200' };
const AMBER: Omit<Pill, 'label' | 'title'> = { dot: 'bg-amber-500', icon: 'text-amber-400', chip: 'text-amber-800 bg-amber-50 border-amber-200' };
const RED: Omit<Pill, 'label' | 'title'> = { dot: 'bg-rose-500', icon: 'text-rose-400', chip: 'text-rose-700 bg-rose-50 border-rose-200' };

function databasePill(status: SystemStatusView | null | 'unavailable'): Pill {
  if (status === null) return { ...GREY, label: 'Checking database…', title: 'Checking the database connection' };
  if (status === 'unavailable') return { ...RED, label: 'Status unavailable', title: 'The CRM could not report its status' };
  return status.database.ok
    ? { ...GREEN, label: 'Database connected', title: 'The CRM can reach its PostgreSQL database' }
    : { ...RED, label: 'Database unreachable', title: 'The CRM cannot reach its PostgreSQL database' };
}

function whatsappPill(status: SystemStatusView | null | 'unavailable'): Pill {
  if (status === null) return { ...GREY, label: 'Checking WhatsApp…', title: 'Checking WhatsApp' };
  if (status === 'unavailable') return { ...RED, label: 'Status unavailable', title: 'The CRM could not report its status' };
  const w = status.whatsapp;
  const recent = w.countsCapped
    ? `In the last hour: at least ${w.sentLastHour} sent and ${w.failedLastHour} failed (only the newest messages are counted).`
    : `In the last hour: ${w.sentLastHour} sent, ${w.failedLastHour} failed.`;
  const last = w.lastSentAt ? `Last successful send ${timeText(w.lastSentAt)}.` : 'No successful send yet.';
  switch (w.state) {
    case 'NOT_CONFIGURED':
      return { ...RED, label: 'WhatsApp not configured', title: 'No Meta access token or phone number id: messages are only simulated and nobody receives them. Set them in System Settings.' };
    case 'FAILING':
      return { ...AMBER, label: 'WhatsApp sends failing', title: `Every recent WhatsApp send failed. ${recent} ${last} See Failed messages on the dispatch board.` };
    case 'OK':
      return { ...GREEN, label: 'WhatsApp configured', title: `${last} ${recent}` };
    default:
      return { ...GREY, label: 'WhatsApp status unknown', title: 'WhatsApp could not be checked' };
  }
}

interface SidebarLayoutProps {
  children: React.ReactNode;
}

export default function SidebarLayout({ children }: SidebarLayoutProps) {
  const pathname = usePathname();
  const [user, setUser] = useState<{ full_name: string; role: string; email: string } | null>(null);
  // Below lg the sidebar is a slide-in menu; from lg up it is always shown and this has no effect.
  const [menuOpen, setMenuOpen] = useState(false);
  // Real status for the pills (GET /api/system/status): null while loading, 'unavailable' if it can't be read.
  const [status, setStatus] = useState<SystemStatusView | null | 'unavailable'>(null);

  useEffect(() => {
    if (!user) return;
    let stopped = false;
    const load = () =>
      fetch('/api/system/status', { cache: 'no-store' })
        .then((res) => res.json())
        .then((data) => !stopped && setStatus(data?.success ? data.status : 'unavailable'))
        .catch(() => !stopped && setStatus('unavailable'));
    load();
    const timer = setInterval(load, STATUS_REFRESH_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [user]);
  const database = databasePill(status);
  const whatsapp = whatsappPill(status);

  // Close the menu when a page is chosen.
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // While the menu is open: Escape closes it, and the page behind does not scroll.
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMenuOpen(false);
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
    };
  }, [menuOpen]);

  useEffect(() => {
    if (pathname === '/login') return;

    fetch('/api/auth/me')
      .then((res) => res.json())
      .then((data) => {
        if (data.authenticated && data.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
      })
      .catch(() => setUser(null));
  }, [pathname]);

  async function handleLogout() {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
      window.location.href = '/login';
    } catch {
      window.location.href = '/login';
    }
  }

  // If on login or public customer trip tracking page, display full-width content without admin sidebar
  if (pathname === '/login' || pathname.startsWith('/trip/')) {
    return <main className="min-h-screen bg-slate-50 overflow-y-auto">{children}</main>;
  }

  const allNavItems: { href: string; label: string; icon: typeof Car; badge?: string; active: boolean; permission: Permission }[] = [
    {
      href: '/',
      label: 'Live Dispatch',
      icon: Car,
      active: pathname === '/',
      permission: 'bookings.view',
    },
    {
      href: '/bookings/new',
      label: 'New Booking',
      icon: PlusCircle,
      active: pathname === '/bookings/new',
      permission: 'bookings.create',
    },
    {
      href: '/catalog',
      label: 'Cabs, Fuel & Plans',
      icon: Package,
      active: pathname.startsWith('/catalog'),
      permission: 'catalog.view',
    },
    {
      href: '/inbox',
      label: 'WhatsApp Inbox',
      icon: MessageSquare,
      badge: 'Live',
      active: pathname.startsWith('/inbox'),
      permission: 'inbox.use',
    },
    {
      href: '/simulator',
      label: 'WA Simulator',
      icon: Smartphone,
      badge: 'Test',
      active: pathname.startsWith('/simulator'),
      permission: 'inbox.use',
    },
    {
      href: '/drivers',
      label: 'Drivers & Fleet',
      icon: Users,
      active: pathname.startsWith('/drivers'),
      permission: 'drivers.view',
    },
    {
      href: '/customers',
      label: 'Customers CRM',
      icon: UserCheck,
      active: pathname.startsWith('/customers'),
      permission: 'customers.view',
    },
    {
      href: '/finance',
      label: 'Finance & Ledger',
      icon: Wallet,
      active: pathname.startsWith('/finance'),
      permission: 'ledger.view',
    },
    {
      href: '/users',
      label: 'Staff & Access',
      icon: ShieldCheck,
      active: pathname.startsWith('/users'),
      permission: 'users.manage',
    },
    {
      href: '/audit',
      label: 'Audit Log',
      icon: ClipboardList,
      active: pathname.startsWith('/audit'),
      permission: 'audit.view',
    },
    {
      href: '/settings',
      label: 'System Settings',
      icon: Sliders,
      active: pathname.startsWith('/settings'),
      permission: 'settings.view',
    },
  ];
  // Hide pages the role cannot use (the API enforces the same rules). Nothing shows until the user loads.
  const navItems = allNavItems.filter((item) => user && hasPermission(user.role, item.permission));

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      {/* Below lg: dims the page while the menu is open; tapping it closes the menu. */}
      {menuOpen && (
        <div className="fixed inset-0 z-30 bg-slate-900/50 lg:hidden" onClick={() => setMenuOpen(false)} aria-hidden="true" />
      )}

      {/* Left Sidebar: a slide-in menu below lg, always shown from lg up */}
      <aside
        id="crm-sidebar"
        className={`fixed inset-y-0 left-0 z-40 w-64 max-w-[85vw] bg-slate-900 border-r border-slate-800 flex flex-col justify-between overflow-y-auto transition-transform duration-200 lg:static lg:z-30 lg:max-w-none lg:translate-x-0 lg:flex-shrink-0 ${menuOpen ? 'translate-x-0' : '-translate-x-full'}`}
      >
        <div>
          {/* Brand Header */}
          <div className="h-16 px-6 flex items-center justify-between border-b border-slate-800">
            <Link href="/" className="flex flex-col">
              <span className="text-xl font-black tracking-tight text-orange-500">
                BIHAR<span className="text-white">CABS</span>
              </span>
              <span className="text-[10px] text-orange-400 font-mono tracking-wider uppercase font-semibold">
                Operational CRM
              </span>
            </Link>
            <button
              onClick={() => setMenuOpen(false)}
              className="lg:hidden p-1.5 -mr-2 text-slate-400 hover:text-white rounded-lg"
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Navigation Links */}
          <nav className="p-3 space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={`flex items-center justify-between px-3.5 py-2.5 rounded-lg text-sm font-medium transition-colors ${
                    item.active
                      ? 'bg-orange-600 text-white font-semibold shadow-sm'
                      : 'text-slate-300 hover:text-white hover:bg-slate-800/80'
                  }`}
                >
                  <div className="flex items-center space-x-3">
                    <Icon className={`h-4 w-4 ${item.active ? 'text-white' : 'text-slate-400'}`} />
                    <span>{item.label}</span>
                  </div>

                  {item.badge && (
                    <span className="flex items-center space-x-1">
                      <span className="relative flex h-2 w-2">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-500"></span>
                      </span>
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        {/* Bottom Sidebar: User & System Status */}
        <div className="p-4 border-t border-slate-800 space-y-3 bg-slate-950/40">
          {/* Database status (real check) */}
          <div title={database.title} className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-800/70 text-[11px] text-slate-300 border border-slate-700/50">
            <div className="flex items-center space-x-1.5">
              <Database className={`h-3.5 w-3.5 ${database.icon}`} />
              <span>{database.label}</span>
            </div>
            <span className={`h-1.5 w-1.5 rounded-full ${database.dot}`}></span>
          </div>

          {/* WhatsApp status: here on phones; in the top bar from md up */}
          <div title={whatsapp.title} className="md:hidden flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-800/70 text-[11px] text-slate-300 border border-slate-700/50">
            <div className="flex items-center space-x-1.5">
              <MessageSquare className={`h-3.5 w-3.5 ${whatsapp.icon}`} />
              <span>{whatsapp.label}</span>
            </div>
            <span className={`h-1.5 w-1.5 rounded-full ${whatsapp.dot}`}></span>
          </div>

          {/* User Profile */}
          {user && (
            <div className="flex items-center justify-between pt-1">
              <div className="flex items-center space-x-2.5 min-w-0">
                <div className="p-2 bg-slate-800 rounded-lg text-slate-300 flex-shrink-0">
                  <User className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-white truncate">
                    {user.full_name}
                  </div>
                  <div className="text-[10px] text-orange-400 font-mono uppercase truncate">
                    {user.role}
                  </div>
                </div>
              </div>

              <button
                onClick={handleLogout}
                title="Sign Out"
                className="p-1.5 text-slate-400 hover:text-rose-400 hover:bg-slate-800 rounded-lg transition"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Top Header Bar */}
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-3 sm:px-6 flex-shrink-0 gap-2">
          <div className="flex items-center space-x-2 text-sm text-slate-600 min-w-0">
            <button
              onClick={() => setMenuOpen(true)}
              className="lg:hidden p-2 -ml-1 text-slate-700 hover:bg-slate-100 rounded-lg flex-shrink-0"
              aria-label="Open menu"
              aria-controls="crm-sidebar"
              aria-expanded={menuOpen}
            >
              <Menu className="h-5 w-5" />
            </button>
            <span className="font-semibold text-slate-900 hidden sm:inline">BiharCabs Operations</span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-600 hidden sm:inline" />
            <span className="capitalize text-slate-500 truncate">
              {pathname === '/' ? 'Live Dispatch' : pathname.replace('/', '').replace(/-/g, ' ')}
            </span>
          </div>

          <div className="hidden md:flex items-center space-x-3">
            <div title={whatsapp.title} className={`flex items-center space-x-2 text-xs px-3 py-1.5 rounded-full border ${whatsapp.chip}`}>
              <span className={`h-2 w-2 rounded-full ${whatsapp.dot}`}></span>
              <span>{whatsapp.label}</span>
            </div>
          </div>
        </header>

        {/* Scrollable Body Content */}
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

