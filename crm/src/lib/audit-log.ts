import { NextRequest } from 'next/server';
import { query } from './db';
import { AdminUser } from './auth';
import { trustedClientIp } from './login-security';

export interface AuditLogInput {
  actor?: Pick<AdminUser, 'id' | 'email' | 'full_name' | 'role'> | null;
  actorEmail?: string | null;
  actorName?: string | null;
  actorRole?: string | null;
  action: string;
  entityType: string;
  entityId?: string | number | null;
  summary: string;
  beforeData?: unknown;
  afterData?: unknown;
  req?: NextRequest | null;
}

const SENSITIVE_KEY_RE = /(password|secret|token|api_key|apikey|salt|hash|authorization)/i;

/**
 * Recursively redact sensitive keys before writing to crm_audit_logs so secrets/passwords never enter audit trails.
 */
export function sanitizeAuditPayload(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return null;
  if (depth > 6) return '[Truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitizeAuditPayload(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY_RE.test(k)) {
        out[k] = '[REDACTED]';
      } else {
        out[k] = sanitizeAuditPayload(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}

export function extractRequestMeta(req?: NextRequest | null): { ip: string | null; userAgent: string | null } {
  if (!req) return { ip: null, userAgent: null };
  const ip =
    trustedClientIp(req) ||
    req.headers.get('x-real-ip')?.trim() ||
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
    null;
  const userAgent = req.headers.get('user-agent')?.slice(0, 500) || null;
  return { ip: ip ? ip.slice(0, 64) : null, userAgent };
}

/**
 * Append an immutable audit event to crm_audit_logs.
 * Never throws so an audit write issue cannot break primary operational flows,
 * while logging any error loudly for observability.
 */
export async function recordAuditLog(input: AuditLogInput): Promise<void> {
  try {
    const { ip, userAgent } = extractRequestMeta(input.req);
    const actorId = input.actor?.id ?? null;
    const actorEmail = input.actor?.email ?? input.actorEmail ?? null;
    const actorName = input.actor?.full_name ?? input.actorName ?? null;
    const actorRole = input.actor?.role ?? input.actorRole ?? null;

    const beforeJson =
      input.beforeData !== undefined ? JSON.stringify(sanitizeAuditPayload(input.beforeData)) : null;
    const afterJson =
      input.afterData !== undefined ? JSON.stringify(sanitizeAuditPayload(input.afterData)) : null;

    await query(
      `INSERT INTO crm_audit_logs
         (actor_id, actor_email, actor_name, actor_role, action, entity_type, entity_id, summary, before_data, after_data, ip_address, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb, $11, $12)`,
      [
        actorId,
        actorEmail,
        actorName,
        actorRole,
        input.action,
        input.entityType,
        input.entityId !== undefined && input.entityId !== null ? String(input.entityId) : null,
        input.summary,
        beforeJson,
        afterJson,
        ip,
        userAgent,
      ]
    );
  } catch (err: any) {
    console.error(`[AuditLog] Failed to record ${input.action}:`, err?.message);
  }
}
