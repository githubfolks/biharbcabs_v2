import { NextRequest, NextResponse } from 'next/server';
import { fetchLiveQuote, QuoteRequestParams } from '@/lib/tariff-bridge';

export async function POST(req: NextRequest) {
  try {
    const params: QuoteRequestParams = await req.json();

    if (!params.origin_city || !params.trip_type || !params.pickup_date) {
      return NextResponse.json(
        {
          success: false,
          error: 'Required fields: origin_city, trip_type, pickup_date',
        },
        { status: 400 }
      );
    }

    const result = await fetchLiveQuote(params);
    return NextResponse.json(result, { status: result.success ? 200 : 400 });
  } catch (err: any) {
    return NextResponse.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}

