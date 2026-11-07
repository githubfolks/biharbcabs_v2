<?php
/**
 * Fare calculation. Pure PHP with no WordPress calls, so the pricing rules can be tested on their own.
 *
 * Per-km fare:
 *   one way / airport: billable km = max(distance, minimum km)
 *                      total = billable km x rate + driver allowance
 *   round trip:        billable km = max(distance x 2, minimum km x days)
 *                      total = billable km x rate + driver allowance x days
 *
 * A fixed route fare is the all-in total. Tolls and parking are never included in either.
 * The formula is shown on the Rate Card screen; keep the two in step.
 */
class BCGE_Calculator {
    /**
     * @param array  $rate      rate_per_km, min_km, driver_allowance
     * @param string $trip_type oneway, airport or roundtrip
     * @param float  $km        One-way distance in km
     * @param int    $days      Trip length in days (round trips only)
     * @return array|null Fare parts, or null when no usable rate is set.
     */
    public static function per_km($rate, $trip_type, $km, $days = 1) {
        $per_km = (float) ($rate['rate_per_km'] ?? 0);
        if ($per_km <= 0 || $km <= 0) {
            return null;
        }
        $min_km    = max(0, (float) ($rate['min_km'] ?? 0));
        $allowance = max(0, (float) ($rate['driver_allowance'] ?? 0));
        $days      = max(1, (int) $days);

        if ($trip_type === 'roundtrip') {
            $billable_km = max($km * 2, $min_km * $days);
            $allowance  *= $days;
        } else {
            $billable_km = max($km, $min_km);
        }

        $base  = (int) round($billable_km * $per_km);
        $extra = (int) round($allowance);

        return array(
            'total_fare'       => $base + $extra,
            'base_fare'        => $base,
            'driver_allowance' => $extra,
            'rate_per_km'      => $per_km,
            'min_km'           => $min_km,
        );
    }

    /** @return array|null Fare parts for a fixed all-in fare, or null when none is set. */
    public static function fixed($fare) {
        $fare = (int) round((float) $fare);
        if ($fare <= 0) {
            return null;
        }
        return array('total_fare' => $fare, 'base_fare' => $fare, 'driver_allowance' => 0);
    }

    /** Whole days between two YYYY-MM-DD dates, counting both ends, or null when return is before pickup. */
    public static function days_between($pickup, $return) {
        $from = DateTimeImmutable::createFromFormat('!Y-m-d', $pickup);
        $to   = DateTimeImmutable::createFromFormat('!Y-m-d', $return);
        if (!$from || !$to || $to < $from) {
            return null;
        }
        return (int) $from->diff($to)->days + 1;
    }

    /** First comma-separated part, lowercased, so "Gaya, Bihar, India" matches a "Gaya" route. */
    public static function place_key($place) {
        $first = explode(',', (string) $place)[0];
        return strtolower(trim(preg_replace('/\s+/', ' ', $first)));
    }

    /**
     * @param string|null $trip_type Limit to this trip type, or null for any.
     * @return array|null The route configured for these places.
     */
    public static function find_route($routes, $origin, $destination, $trip_type = null) {
        $from = self::place_key($origin);
        $to   = self::place_key($destination);
        if ($from === '' || $to === '') {
            return null;
        }
        foreach ($routes as $route) {
            if ($trip_type !== null && ($route['trip_type'] ?? '') !== $trip_type) {
                continue;
            }
            $a = self::place_key($route['origin'] ?? '');
            $b = self::place_key($route['destination'] ?? '');
            if (($a === $from && $b === $to) || (!empty($route['both_ways']) && $a === $to && $b === $from)) {
                return $route;
            }
        }
        return null;
    }

    /** Distance saved on any route between these places, as the road is the same for every trip type. */
    public static function known_distance($routes, $origin, $destination) {
        foreach ($routes as $route) {
            if (is_numeric($route['distance_km'] ?? null) && $route['distance_km'] > 0
                && self::find_route(array($route), $origin, $destination)) {
                return (float) $route['distance_km'];
            }
        }
        return 0.0;
    }
}
