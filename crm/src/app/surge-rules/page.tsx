'use client';

import { useState, useEffect } from 'react';
import { Flame } from 'lucide-react';
import { hasPermission } from '@/lib/permissions';
import PricingRulesPanel from '@/components/PricingRulesPanel';

export default function SurgeRulesPage() {
  const [role, setRole] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/auth/me', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (d?.authenticated && d?.user?.role) setRole(d.user.role);
      })
      .catch(() => {});
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2">
          <Flame className="h-6 w-6 text-orange-600" /> Peak-Season, Night &amp; Festival Surge Rules
        </h1>
        <p className="text-sm text-slate-600">
          Manage dynamic percentage or flat surcharges for festivals (Chhath, Holi, Diwali, Lagan), late-night windows, and peak city demand.
        </p>
      </div>

      <PricingRulesPanel canManage={hasPermission(role, 'catalog.manage')} />
    </div>
  );
}
