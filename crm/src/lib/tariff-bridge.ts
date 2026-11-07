import { getWpApiConfig } from './settings';

export interface QuoteRequestParams {
  origin_city: string;
  destination_city?: string;
  trip_type: 'oneway' | 'roundtrip' | 'airport' | 'local';
  pickup_date: string;
  pickup_time?: string;
  return_date?: string;
  duration_days?: number;
  customer_phone?: string;
  customer_name?: string;
}

export interface VehicleQuote {
  vehicle_code: string;
  vehicle_name: string;
  vehicle_models: string;
  seating_capacity: number;
  luggage_bags: number;
  total_fare: number;
  base_fare: number;
  driver_allowance: number;
  toll_tax_text: string;
  rate_per_km?: number;
  min_km?: number;
}

export interface QuoteResponse {
  success: boolean;
  route?: {
    origin: string;
    destination: string;
    distance_km: number;
    duration_text: string;
    is_fixed_tariff: boolean;
  };
  quotes: VehicleQuote[];
  error?: {
    code: string;
    message: string;
  };
}

/**
 * Connect to BiharCabs WordPress REST API to fetch live route tariffs.
 * Never generates synthetic fallback data. Fails gracefully if route is unlisted,
 * allowing the CRM to route to Admin Custom Quote mode.
 */
export async function fetchLiveQuote(params: QuoteRequestParams): Promise<QuoteResponse> {
  const wpConfig = await getWpApiConfig();
  const url = `${wpConfig.base_url.replace(/\/+$/, '')}${wpConfig.quote_endpoint}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };

  if (wpConfig.api_key) {
    headers['Authorization'] = `Bearer ${wpConfig.api_key}`;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(params),
      // 8 second timeout to avoid hanging
      signal: AbortSignal.timeout(8000),
    });

    const data = await response.json();

    if (!response.ok || !data.success) {
      return {
        success: false,
        quotes: [],
        error: {
          code: data.code || 'PRICING_API_ERROR',
          message: data.message || `Pricing API responded with HTTP ${response.status}`,
        },
      };
    }

    return {
      success: true,
      route: data.route,
      quotes: data.quotes || [],
    };
  } catch (err: any) {
    return {
      success: false,
      quotes: [],
      error: {
        code: err.name === 'TimeoutError' ? 'PRICING_TIMEOUT' : 'PRICING_UNREACHABLE',
        message: err.message || 'Unable to connect to BiharCabs pricing engine',
      },
    };
  }
}

