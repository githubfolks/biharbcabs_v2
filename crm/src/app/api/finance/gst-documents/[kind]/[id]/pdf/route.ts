import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '@/lib/auth';
import { GstDocumentKind, GstPdfError, gstDocumentPdf } from '@/lib/gst-pdf';

export const dynamic = 'force-dynamic';

/** The PDF of an issued GST document (kind TI, RV, RF or CC), for finance. */
export async function GET(req: NextRequest, { params }: { params: { kind: string; id: string } }) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;
  try {
    const pdf = await gstDocumentPdf(String(params.kind || '').toUpperCase() as GstDocumentKind, Number(params.id));
    return new NextResponse(new Uint8Array(pdf.buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `attachment; filename="${pdf.fileName}"`,
        'Cache-Control': 'private, no-store',
      },
    });
  } catch (err: any) {
    if (err instanceof GstPdfError) {
      return NextResponse.json({ success: false, error: err.message }, { status: err.status });
    }
    console.error('[GST] PDF failed:', err?.message);
    return NextResponse.json({ success: false, error: 'Could not produce the PDF' }, { status: 500 });
  }
}
