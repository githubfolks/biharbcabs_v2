import { NextResponse } from 'next/server';

/**
 * Base class for safe, user-facing domain errors thrown by backend services.
 * Only DomainError messages are returned directly to API clients; all other errors
 * (e.g. PostgreSQL, filesystem, network) are logged server-side and returned as a generic 500.
 */
export class DomainError extends Error {
  readonly status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = new.target.name;
    this.status = status;
  }
}

/**
 * Unified API route error handler:
 * - DomainError (or an error with an explicit 4xx `status` property): returns its safe message & status.
 * - Unexpected error: logs full details server-side and returns a generic 500 message (never leaking DB/internal errors).
 */
export function handleRouteError(
  err: unknown,
  label: string,
  fallbackMessage = 'Internal server error',
  extra?: Record<string, unknown>
): NextResponse {
  if (err instanceof DomainError) {
    return NextResponse.json({ success: false, error: err.message, ...extra }, { status: err.status });
  }
  const maybeStatus = (err as any)?.status;
  if (
    err instanceof Error &&
    typeof maybeStatus === 'number' &&
    maybeStatus >= 400 &&
    maybeStatus < 500
  ) {
    return NextResponse.json({ success: false, error: err.message, ...extra }, { status: maybeStatus });
  }
  console.error(`[${label}] Unexpected error:`, err);
  return NextResponse.json({ success: false, error: fallbackMessage, ...extra }, { status: 500 });
}
