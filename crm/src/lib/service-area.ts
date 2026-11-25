import { geocodePlace } from './locationiq';
import { getAdminContacts, getCompanyBillingInfo, getServiceCoverageConfig, ServiceCoverageConfig } from './settings';

export class ServiceAreaError extends Error {
  readonly status = 422;
  readonly code: 'ORIGIN_NOT_SERVICED' | 'DESTINATION_NOT_SERVICED' | 'ROUTE_BLOCKED';
  constructor(
    message: string,
    code: 'ORIGIN_NOT_SERVICED' | 'DESTINATION_NOT_SERVICED' | 'ROUTE_BLOCKED'
  ) {
    super(message);
    this.code = code;
  }
}

export interface ServiceabilityResult {
  serviceable: boolean;
  code: 'OK' | 'ORIGIN_NOT_SERVICED' | 'DESTINATION_NOT_SERVICED' | 'ROUTE_BLOCKED';
  reason: string | null;
  supportPhone: string | null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Word-boundary case-insensitive match against one or more candidate text strings
 * (e.g. raw user input + geocoded display_name like "Katihar, Bihar, India").
 */
function matchesAny(haystacks: Array<string | null | undefined>, allowedList: string[]): boolean {
  const cleanedHaystacks = haystacks
    .map((h) => String(h || '').trim().toLowerCase())
    .filter(Boolean);
  if (cleanedHaystacks.length === 0) return false;

  for (const rawAllowed of allowedList) {
    const token = String(rawAllowed || '').trim().toLowerCase();
    if (!token) continue;
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(token)}($|[^a-z0-9])`, 'i');
    for (const h of cleanedHaystacks) {
      if (h === token || re.test(h)) return true;
    }
  }
  return false;
}

function isRouteBlocked(
  originHaystacks: Array<string | null | undefined>,
  destHaystacks: Array<string | null | undefined>,
  blockedRoutes: string[]
): boolean {
  for (const rule of blockedRoutes) {
    const parts = String(rule || '').split(/->|→|\bto\b/i).map((p) => p.trim()).filter(Boolean);
    if (parts.length !== 2) continue;
    if (matchesAny(originHaystacks, [parts[0]]) && matchesAny(destHaystacks, [parts[1]])) {
      return true;
    }
  }
  return false;
}

/**
 * Pure service-area evaluator (unit-testable without DB or network calls).
 */
export function evaluateServiceCoverage(
  config: ServiceCoverageConfig,
  input: {
    origin?: string | null;
    destination?: string | null;
    originDisplayName?: string | null;
    destinationDisplayName?: string | null;
    supportPhone?: string | null;
  }
): ServiceabilityResult {
  const supportPhone = input.supportPhone ? String(input.supportPhone).trim() : null;
  const contactHint = supportPhone
    ? ` Please contact our support team at ${supportPhone} for assistance.`
    : ' Please contact our support team for assistance.';

  if (!config.enabled) {
    return { serviceable: true, code: 'OK', reason: null, supportPhone };
  }

  const originText = input.origin ? String(input.origin).trim() : '';
  const destText = input.destination ? String(input.destination).trim() : '';
  const originHaystacks = [originText, input.originDisplayName];
  const destHaystacks = [destText, input.destinationDisplayName];

  // 1. Blocked routes check (highest priority when both origin & destination are present)
  if (originText && destText && config.blocked_routes.length > 0) {
    if (isRouteBlocked(originHaystacks, destHaystacks, config.blocked_routes)) {
      return {
        serviceable: false,
        code: 'ROUTE_BLOCKED',
        reason: `Sorry, we currently do not operate cab service on the ${originText} → ${destText} route.${contactHint}`,
        supportPhone,
      };
    }
  }

  // 2. Origin serviceability check
  if (originText) {
    if (config.origin_cities.length > 0) {
      if (!matchesAny(originHaystacks, config.origin_cities)) {
        return {
          serviceable: false,
          code: 'ORIGIN_NOT_SERVICED',
          reason: `Sorry, we do not currently provide pickup service in "${originText}".${contactHint}`,
          supportPhone,
        };
      }
    } else if (config.allowed_states.length > 0) {
      if (!matchesAny(originHaystacks, config.allowed_states)) {
        return {
          serviceable: false,
          code: 'ORIGIN_NOT_SERVICED',
          reason: `Sorry, we do not currently provide pickup service in "${originText}".${contactHint}`,
          supportPhone,
        };
      }
    }
  }

  // 3. Destination serviceability check (matches destination_cities OR allowed_states)
  if (destText && (config.destination_cities.length > 0 || config.allowed_states.length > 0)) {
    const allowedDest = [...config.destination_cities, ...config.allowed_states];
    if (!matchesAny(destHaystacks, allowedDest)) {
      return {
        serviceable: false,
        code: 'DESTINATION_NOT_SERVICED',
        reason: `Sorry, we do not currently provide cab service to "${destText}".${contactHint}`,
        supportPhone,
      };
    }
  }

  return { serviceable: true, code: 'OK', reason: null, supportPhone };
}

async function resolveSupportPhone(): Promise<string | null> {
  const [billing, admins] = await Promise.all([getCompanyBillingInfo(), getAdminContacts()]);
  return (
    (billing?.phone && String(billing.phone).trim()) ||
    admins.find((a) => a.phone)?.phone ||
    null
  );
}

/**
 * Full async service-area check: loads dynamic `service_coverage` from crm_settings,
 * enriches with LocationIQ geocoding when `allowed_states` is configured and raw text
 * didn't already match, and returns a clear user-facing result.
 */
export async function checkRouteServiceability(input: {
  origin?: string | null;
  destination?: string | null;
  originDisplayName?: string | null;
  destinationDisplayName?: string | null;
}): Promise<ServiceabilityResult> {
  const config = await getServiceCoverageConfig();
  if (!config.enabled) {
    return { serviceable: true, code: 'OK', reason: null, supportPhone: null };
  }

  const supportPhone = await resolveSupportPhone();
  let originDisplayName = input.originDisplayName ?? null;
  let destinationDisplayName = input.destinationDisplayName ?? null;

  // Fast pass without geocoding first
  const initial = evaluateServiceCoverage(config, {
    ...input,
    originDisplayName,
    destinationDisplayName,
    supportPhone,
  });
  if (initial.serviceable) return initial;

  // If allowed_states is configured and we don't yet have geocoded display names, resolve via LocationIQ
  if (config.allowed_states.length > 0) {
    if (initial.code === 'ORIGIN_NOT_SERVICED' && input.origin && !originDisplayName) {
      try {
        const geo = await geocodePlace(input.origin);
        originDisplayName = geo?.display_name ?? null;
      } catch {
        // Leave null; evaluation will honestly report unserviced
      }
    }
    if (initial.code === 'DESTINATION_NOT_SERVICED' && input.destination && !destinationDisplayName) {
      try {
        const geo = await geocodePlace(input.destination);
        destinationDisplayName = geo?.display_name ?? null;
      } catch {
        // Leave null
      }
    }
    return evaluateServiceCoverage(config, {
      ...input,
      originDisplayName,
      destinationDisplayName,
      supportPhone,
    });
  }

  return initial;
}

/** Throws ServiceAreaError (HTTP 422) when origin/destination/route is outside configured service coverage. */
export async function assertRouteServiceable(input: {
  origin?: string | null;
  destination?: string | null;
  originDisplayName?: string | null;
  destinationDisplayName?: string | null;
}): Promise<void> {
  const res = await checkRouteServiceability(input);
  if (!res.serviceable && res.code !== 'OK') {
    throw new ServiceAreaError(
      res.reason || 'This route is outside our current service area.',
      res.code
    );
  }
}
