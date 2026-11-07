/**
 * Read a customer's pickup time from a WhatsApp reply, in India Standard Time (UTC+5:30, no DST).
 *
 * Understands "now", "today 6:30 pm", "tomorrow 9 am", "6 pm" (next occurrence), "12/11 7:30 pm",
 * "12-11-2026 18:30" and "2026-11-12 18:30". Returns null for anything else, so the bot can ask again.
 * Dates are day-first, as written in India.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const MAX_DAYS_AHEAD = 60;
const PAST_GRACE_MS = 10 * 60 * 1000;

export interface PickupTime {
  date: string; // YYYY-MM-DD in IST
  time: string; // HH:MM in IST, 24-hour
  at: Date;
}

function istParts(d: Date) {
  const ist = new Date(d.getTime() + IST_OFFSET_MS);
  return { y: ist.getUTCFullYear(), m: ist.getUTCMonth() + 1, d: ist.getUTCDate(), h: ist.getUTCHours(), min: ist.getUTCMinutes() };
}

function fromIst(y: number, m: number, d: number, h: number, min: number): Date | null {
  const utc = Date.UTC(y, m - 1, d, h, min) - IST_OFFSET_MS;
  const check = istParts(new Date(utc));
  if (check.y !== y || check.m !== m || check.d !== d || check.h !== h || check.min !== min) return null;
  return new Date(utc);
}

function toPickup(at: Date): PickupTime {
  const p = istParts(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return { date: `${p.y}-${pad(p.m)}-${pad(p.d)}`, time: `${pad(p.h)}:${pad(p.min)}`, at };
}

/** "6", "6:30", "6.30", "18:30", optional am/pm. */
function parseClock(text: string): { h: number; min: number } | null {
  const m = text.trim().match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.)?$/i);
  if (!m) return null;
  let h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  const ampm = m[3]?.toLowerCase().replace(/\./g, '');
  if (min > 59) return null;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
  } else if (!m[2] || h > 23) {
    return null; // A bare "6" is ambiguous without am/pm.
  }
  return { h, min };
}

export function parsePickupTime(input: string, now: Date = new Date()): PickupTime | null {
  const text = input.trim().toLowerCase().replace(/\s+/g, ' ').replace(/,/g, ' ').trim();
  if (!text) return null;

  if (/^(now|asap|right now|immediately|abhi)$/.test(text)) return toPickup(now);

  const today = istParts(now);
  let y = today.y, m = today.m, d = today.d;
  let clockText = text;
  let explicitDay = false;

  let match: RegExpMatchArray | null;
  if ((match = text.match(/^(today|tomorrow|tmrw|kal)\s+(.+)$/))) {
    if (match[1] !== 'today') {
      const next = istParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      y = next.y; m = next.m; d = next.d;
    }
    clockText = match[2];
    explicitDay = true;
  } else if ((match = text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(.+)$/))) {
    y = Number(match[1]); m = Number(match[2]); d = Number(match[3]);
    clockText = match[4];
    explicitDay = true;
  } else if ((match = text.match(/^(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\s+(.+)$/))) {
    d = Number(match[1]); m = Number(match[2]);
    y = match[3] ? (match[3].length === 2 ? 2000 + Number(match[3]) : Number(match[3])) : today.y;
    clockText = match[4];
    explicitDay = true;
  }

  const clock = parseClock(clockText.replace(/^at\s+/, ''));
  if (!clock) return null;

  let at = fromIst(y, m, d, clock.h, clock.min);
  if (!at) return null;

  // A day-month without a year that has already passed means next year; a bare time that has passed means tomorrow.
  if (at.getTime() < now.getTime() - PAST_GRACE_MS) {
    if (!explicitDay) {
      const next = istParts(new Date(now.getTime() + 24 * 60 * 60 * 1000));
      at = fromIst(next.y, next.m, next.d, clock.h, clock.min);
    } else if (/^\d{1,2}[/-]\d{1,2}\s/.test(text)) {
      at = fromIst(y + 1, m, d, clock.h, clock.min);
    } else {
      return null;
    }
    if (!at) return null;
  }

  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * 24 * 60 * 60 * 1000) return null;
  return toPickup(at);
}

/** Pickup moment for a stored booking date and time, read as IST. */
export function pickupMoment(date: string, time: string): Date | null {
  const dm = String(date).match(/^(\d{4})-(\d{2})-(\d{2})/);
  const tm = String(time).match(/^(\d{1,2}):(\d{2})/);
  if (!dm || !tm) return null;
  return fromIst(Number(dm[1]), Number(dm[2]), Number(dm[3]), Number(tm[1]), Number(tm[2]));
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu 12 Nov, 6:30 PM" for messages. Built by hand so it reads the same on every server. */
export function formatPickup(at: Date): string {
  const p = istParts(at);
  const weekday = WEEKDAYS[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
  const h12 = p.h % 12 || 12;
  return `${weekday} ${p.d} ${MONTHS[p.m - 1]}, ${h12}:${String(p.min).padStart(2, '0')} ${p.h < 12 ? 'AM' : 'PM'}`;
}
