'use client';

import { useState, useEffect } from 'react';
import { Globe } from 'lucide-react';
import { hasPermission } from '@/lib/permissions';
import SeoRoutesPanel from '@/components/SeoRoutesPanel';

export default function SeoRoutesPage() {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d?.authenticated && d?.user?.role) setRole(d.user.role);
      })
      .catch((err) => {
        console.error('[SeoRoutesPage] Failed to load current user role:', err);
      });
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Globe className="h-6 w-6 text-orange-600" /> Dynamic Route SEO Pages
        </h1>
        <p className="text-sm text-slate-600">
          Create and manage WordPress city-pair SEO landing pages powered by live CRM fares, structured JSON-LD schema, and instant booking.
        </p>
      </div>

      <SeoRoutesPanel canManage={hasPermission(role, 'catalog.manage')} />
    </div>
  );
}
