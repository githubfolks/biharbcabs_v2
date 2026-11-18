import { fetchLiveQuote } from './tariff-bridge';
import { hasPermission } from './permissions';

/**
 * The fare for a booking created by staff, decided on the server (owner decision):
 * - It is the rate-card fare: the same WordPress quote the WhatsApp bot uses, for the route and cab type.
 * - Only the super admin (bookings.override_fare) may book a different fare, for an unlisted route or a
 *   negotiated price, with a reason. The rate-card fare (if any), who changed it and why are recorded.
 * A fare equal to the rate card is never an override.
 */

export const MIN_OVERRIDE_REASON_LENGTH = 10;

export class FareError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export interface StaffFare {
  fare: number;
  distanceKm: number;
  source: 'RATE_CARD' | 'OVERRIDE';
  rateCardFare: number | null;
  overrideReason: string | null;
}

export async function resolveStaffFare(input: {
  originCity: string;
  destinationCity?: string | null;
  tripType: string;
  pickupDate: string;
  pickupTime?: string;
  vehicleCode: string;
  /** Fare typed by staff, if any. */
  requestedFare?: unknown;
  overrideReason?: unknown;
  /** Distance typed by staff; used only for an override when the rate card has no route. */
  requestedDistanceKm?: unknown;
  role: string;
}): Promise<StaffFare> {
  const quote = await fetchLiveQuote({
    origin_city: input.originCity,
    destination_city: input.destinationCity || undefined,
    trip_type: input.tripType as any,
    pickup_date: input.pickupDate,
    pickup_time: input.pickupTime,
  });
  const match = quote.success
    ? quote.quotes.find((q) => String(q.vehicle_code).toLowerCase() === String(input.vehicleCode).toLowerCase())
    : undefined;
  const rateCardFare = match && Number(match.total_fare) > 0 ? Number(match.total_fare) : null;
  const routeKm = Number(quote.route?.distance_km);
  // The WordPress quote endpoint answers NO_TARIFF / OUT_OF_SERVICE_AREA for routes it does not price
  // (class-rest.php); anything else unsuccessful means the rate card could not be used.
  const notListed = quote.success || ['NO_TARIFF', 'OUT_OF_SERVICE_AREA'].includes(String(quote.error?.code || ''));
  const route = `${input.originCity}${input.destinationCity ? ` to ${input.destinationCity}` : ''}`;
  const noRateCard = notListed
    ? `This ${quote.success ? 'cab type' : 'trip'} is not on the rate card for ${route}`
    : `The rate card could not be reached (${quote.error?.message || 'pricing service error'})`;

  const raw = input.requestedFare;
  const requested = raw === undefined || raw === null || String(raw).trim() === '' ? null : Number(raw);
  if (requested !== null && !(Number.isFinite(requested) && requested > 0)) {
    throw new FareError('The fare must be a positive amount.', 400);
  }
  const sameAsRateCard = requested === null || (rateCardFare !== null && Math.abs(requested - rateCardFare) < 0.005);

  if (sameAsRateCard) {
    if (rateCardFare === null) {
      throw new FareError(`${noRateCard}. Only the super admin can set a fare for this booking.`, 409);
    }
    return { fare: rateCardFare, distanceKm: Number.isFinite(routeKm) ? routeKm : 0, source: 'RATE_CARD', rateCardFare, overrideReason: null };
  }

  // A different fare: super admin only, with a reason.
  if (!hasPermission(input.role, 'bookings.override_fare')) {
    throw new FareError(
      rateCardFare !== null
        ? `Staff bookings use the rate-card fare of ₹${rateCardFare.toLocaleString('en-IN')}. Only the super admin can book a different fare.`
        : `${noRateCard}. Only the super admin can set a fare for this booking.`,
      403
    );
  }
  const reason = String(input.overrideReason ?? '').trim();
  if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
    throw new FareError(`A fare different from the rate card needs a reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters.`, 400);
  }
  const typedKm = Number(input.requestedDistanceKm);
  return {
    fare: requested!,
    distanceKm: Number.isFinite(routeKm) && routeKm > 0 ? routeKm : Number.isFinite(typedKm) && typedKm > 0 ? typedKm : 0,
    source: 'OVERRIDE',
    rateCardFare,
    overrideReason: reason,
  };
}
