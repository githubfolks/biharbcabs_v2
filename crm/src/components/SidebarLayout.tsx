'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { 
  Car, MessageSquare, Users, Wallet, Sliders, LogOut, User, Database, ChevronRight 
} from 'lucide-react';

interface SidebarLayoutProps {
  children: React.ReactNode;
}

export default function SidebarLayout({ children }: SidebarLayoutProps) {
  const pathname = usePathname();
  const [user, setUser] = useState<{ full_name: string; role: string; email: string } | null>(null);

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

  // If on login page, display full-width content without sidebar
  if (pathname === '/login') {
    return <main className="min-h-screen bg-slate-50">{children}</main>;
  }

  const navItems = [
    {
      href: '/',
      label: 'Live Dispatch',
      icon: Car,
      active: pathname === '/',
    },
    {
      href: '/inbox',
      label: 'WhatsApp Inbox',
      icon: MessageSquare,
      badge: 'Live',
      active: pathname.startsWith('/inbox'),
    },
    {
      href: '/drivers',
      label: 'Drivers & Fleet',
      icon: Users,
      active: pathname.startsWith('/drivers'),
    },
    {
      href: '/finance',
      label: 'Finance & Ledger',
      icon: Wallet,
      active: pathname.startsWith('/finance'),
    },
    {
      href: '/settings',
      label: 'System Settings',
      icon: Sliders,
      active: pathname.startsWith('/settings'),
    },
  ];

  return (
    <div className="flex h-screen bg-slate-50 overflow-hidden font-sans">
      {/* Left Sidebar */}
      <aside className="w-64 bg-slate-900 border-r border-slate-800 flex flex-col justify-between flex-shrink-0 z-30">
        <div>
          {/* Brand Header */}
          <div className="h-16 px-6 flex items-center border-b border-slate-800">
            <Link href="/" className="flex flex-col">
              <span className="text-xl font-black tracking-tight text-orange-500">
                BIHAR<span className="text-white">CABS</span>
              </span>
              <span className="text-[10px] text-orange-400 font-mono tracking-wider uppercase font-semibold">
                Operational CRM
              </span>
            </Link>
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
          {/* Database Connection Pill */}
          <div className="flex items-center justify-between px-2.5 py-1.5 rounded-md bg-slate-800/70 text-[11px] text-slate-300 border border-slate-700/50">
            <div className="flex items-center space-x-1.5">
              <Database className="h-3.5 w-3.5 text-emerald-400" />
              <span>Native PostgreSQL</span>
            </div>
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500"></span>
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
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-6 flex-shrink-0">
          <div className="flex items-center space-x-2 text-sm text-slate-600">
            <span className="font-semibold text-slate-900">BiharCabs Operations</span>
            <ChevronRight className="h-3.5 w-3.5 text-slate-400" />
            <span className="capitalize text-slate-500">
              {pathname === '/' ? 'Live Dispatch' : pathname.replace('/', '').replace(/-/g, ' ')}
            </span>
          </div>

          <div className="flex items-center space-x-3">
            <div className="flex items-center space-x-2 text-xs text-slate-500 bg-slate-50 px-3 py-1.5 rounded-full border border-slate-200">
              <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
              <span>WhatsApp Cloud API Active</span>
            </div>
          </div>
        </header>

        {/* Scrollable Body Content */}
        <main className="flex-1 overflow-y-auto p-6 md:p-8">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

