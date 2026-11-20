/** Shared request helpers for the driver edit routes. */
import { NextRequest, NextResponse } from 'next/server';
import { DriverEditError } from './driver-edits';

export function positiveId(value: string | undefined): number | null {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function jsonBody(req: NextRequest): Promise<any | undefined> {
  try {
    return await req.json();
  } catch {
    return undefined;
  }
}

export function badRequest(error: string) {
  return NextResponse.json({ success: false, error }, { status: 400 });
}

export function editErrorResponse(err: any, what: string) {
  if (err instanceof DriverEditError) {
    return NextResponse.json({ success: false, error: err.message }, { status: err.status });
  }
  console.error(`[Driver Edit] ${what} failed:`, err?.message);
  return NextResponse.json({ success: false, error: `${what} failed` }, { status: 500 });
}
