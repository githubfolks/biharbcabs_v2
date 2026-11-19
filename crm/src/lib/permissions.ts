/**
 * CRM role permissions. The API enforces these (requireAdmin in auth.ts); the UI reads the same map
 * only to hide what a role cannot use. No server-only imports, so client components can use it too.
 *
 * Agreed matrix: dispatchers run rides and talk to customers, finance handles money, only the super
 * admin changes settings. Waiving a customer advance is limited to super admin and finance.
 */

export const ROLES = ['SUPER_ADMIN', 'DISPATCHER', 'FINANCE_MANAGER'] as const;
export type Role = (typeof ROLES)[number];

const ALL: readonly Role[] = ROLES;
const SUPER: readonly Role[] = ['SUPER_ADMIN'];
const OPS: readonly Role[] = ['SUPER_ADMIN', 'DISPATCHER'];
const MONEY: readonly Role[] = ['SUPER_ADMIN', 'FINANCE_MANAGER'];

export const PERMISSIONS = {
  'bookings.view': ALL,
  'bookings.create': OPS,
  'bookings.waive_advance': MONEY,
  'bookings.cancel': ALL,
  'bookings.override_fare': SUPER,
  'refunds.manage': MONEY,
  'dispatch.manage': OPS,
  'drivers.view': ALL,
  'drivers.manage': OPS,
  'ratings.view': ALL,
  'ratings.dispute': OPS,
  'incentives.award': MONEY,
  'ledger.view': MONEY,
  'ledger.settle': MONEY,
  'payouts.record': MONEY,
  'dues.record': MONEY,
  'settings.view': ALL,
  'settings.change': SUPER,
  'inbox.use': OPS,
  'pricing.quote': ALL,
  'invoices.manage': MONEY,
  'notifications.resolve': ALL,
} as const satisfies Record<string, readonly Role[]>;

export type Permission = keyof typeof PERMISSIONS;

/** Unknown roles get nothing. */
export function hasPermission(role: string | null | undefined, permission: Permission): boolean {
  return (PERMISSIONS[permission] as readonly string[]).includes(String(role || ''));
}
