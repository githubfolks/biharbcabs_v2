/**
 * Which manual status changes staff may make to a driver (migration 30). The API enforces these in
 * driver-status.ts; the UI reads the same rules only to offer the allowed actions. No server-only
 * imports, so client components can use it too.
 *
 * Dues statuses (RESTRICTED_DIGITAL_ONLY, SUSPENDED_UNPAID_DUES) cannot be activated by hand: they lift
 * when the driver pays, through the dues payment, settlement and incentive code.
 */

export const DRIVER_STATUS_ACTIONS = ['ACTIVATE', 'SUSPEND', 'OFFBOARD'] as const;
export type DriverStatusAction = (typeof DRIVER_STATUS_ACTIONS)[number];

export const ACTION_TARGET: Record<DriverStatusAction, string> = {
  ACTIVATE: 'APPROVED_ACTIVE',
  SUSPEND: 'SUSPENDED_MANUAL',
  OFFBOARD: 'OFFBOARDED',
};

const ACTIVATABLE = ['PENDING_DOCS', 'SUSPENDED_DOC_EXPIRED', 'SUSPENDED_QUALITY', 'SUSPENDED_MANUAL', 'OFFBOARDED'];

export function isActionAllowed(action: DriverStatusAction, currentStatus: string): boolean {
  switch (action) {
    case 'ACTIVATE':
      return ACTIVATABLE.includes(currentStatus);
    case 'SUSPEND':
      return currentStatus !== 'SUSPENDED_MANUAL' && currentStatus !== 'OFFBOARDED';
    case 'OFFBOARD':
      return currentStatus !== 'OFFBOARDED';
  }
}

export function allowedActions(currentStatus: string): DriverStatusAction[] {
  return DRIVER_STATUS_ACTIONS.filter((a) => isActionAllowed(a, currentStatus));
}

export const REASON_MIN = 5;
export const REASON_MAX = 500;
