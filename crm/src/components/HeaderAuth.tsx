'use client';

import { useState, useEffect } from 'react';
import { LogOut, User } from 'lucide-react';
import { usePathname } from 'next/navigation';

export default function HeaderAuth() {
  const pathname = usePathname();
  const [user, setUser] = useState<{ full_name: string; role: string } | null>(null);

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

  if (pathname === '/login') {
    return (
      <div className="flex items-center space-x-2 text-xs text-slate-400">
        <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse"></span>
        <span>Native PostgreSQL</span>
      </div>
    );
  }

  return (
    <div className="flex items-center space-x-4">
      {user && (
        <div className="hidden sm:flex items-center space-x-2 text-xs">
          <div className="bg-slate-800 p-1.5 rounded-full text-slate-300">
            <User className="h-3.5 w-3.5" />
          </div>
          <div>
            <div className="font-semibold text-white leading-tight">{user.full_name}</div>
            <div className="text-[10px] text-orange-400 font-mono uppercase">{user.role}</div>
          </div>
        </div>
      )}
      <button
        onClick={handleLogout}
        className="inline-flex items-center px-2.5 py-1.5 border border-slate-700 text-xs font-medium rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition"
      >
        <LogOut className="h-3 w-3 mr-1" />
        Sign Out
      </button>
    </div>
  );
}

