import { NextRequest, NextResponse } from 'next/server';
import { handleRouteError } from '@/lib/route-errors';
import { requireAdmin } from '@/lib/auth';
import { recordAuditLog } from '@/lib/audit-log';
import {
  FinancialReportType,
  VALID_REPORT_TYPES,
  formatReportAsCsv,
  getDriverDuesAgingReport,
  getDriverSettlementReport,
  getGstr1Register,
  getReconciliationReport,
  getRevenuePnlReport,
  resolveDateRange,
} from '@/lib/financial-reports';

export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const auth = await requireAdmin(req, 'ledger.view');
  if (auth instanceof NextResponse) return auth;

  try {
    const { searchParams } = new URL(req.url);
    const reportRaw = (searchParams.get('report') || 'pnl').trim() as FinancialReportType;
    const format = (searchParams.get('format') || 'json').trim().toLowerCase();

    if (!VALID_REPORT_TYPES.includes(reportRaw)) {
      return NextResponse.json(
        { success: false, error: `Invalid report type. Must be one of: ${VALID_REPORT_TYPES.join(', ')}` },
        { status: 400 }
      );
    }

    const range = resolveDateRange(searchParams.get('from'), searchParams.get('to'));

    let data: any;
    switch (reportRaw) {
      case 'pnl':
        data = await getRevenuePnlReport(range);
        break;
      case 'gstr1':
        data = await getGstr1Register(range);
        break;
      case 'dues_aging':
        data = await getDriverDuesAgingReport();
        break;
      case 'settlements':
        data = await getDriverSettlementReport(range);
        break;
      case 'reconciliation':
        data = await getReconciliationReport(range);
        break;
    }

    if (format === 'csv') {
      const { filename, csv } = formatReportAsCsv(reportRaw, data);
      await recordAuditLog({
        actor: auth,
        action: 'REPORT_EXPORTED',
        entityType: 'FINANCE',
        entityId: reportRaw,
        summary: `Exported CSV financial report '${reportRaw}' (${range.from} to ${range.to})`,
        afterData: { report: reportRaw, from: range.from, to: range.to, rows: data.rows?.length ?? 0 },
        req,
      });

      return new NextResponse(csv, {
        status: 200,
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      });
    }

    return NextResponse.json({ success: true, ...data });
  } catch (err: any) {
    console.error('[FinanceReports] Error:', err?.message);
    return handleRouteError(err, 'API finance/reports');
  }
}
