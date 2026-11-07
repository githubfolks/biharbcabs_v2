<?php
if (!defined('ABSPATH')) exit;

/**
 * POST /wp-json/biharcabs/v1/quote
 *
 * Used by the website and the CRM (crm/src/lib/tariff-bridge.ts); keep the response in step with
 * QuoteResponse there. Prices are worked out here from the rate card and a server-side distance.
 * Unknown routes return NO_TARIFF so callers fall back to a custom quote; a price is never guessed.
 */
class BCGE_Rest {
    const RATE_LIMIT  = 60;
    const RATE_WINDOW = 600;
    const DISTANCE_TTL = WEEK_IN_SECONDS;

    public static function register() {
        register_rest_route('biharcabs/v1', '/quote', array(
            'methods'             => 'POST',
            'callback'            => array(__CLASS__, 'quote'),
            'permission_callback' => '__return_true', // Public by design: visitors see these estimates.
        ));
    }

    private static function fail($code, $message, $status = 200) {
        return new WP_REST_Response(array('success' => false, 'code' => $code, 'message' => $message, 'quotes' => array()), $status);
    }

    /** Coarse per-IP throttle to protect the LocationIQ quota. Not atomic, which is fine for cost control. */
    private static function within_rate_limit() {
        $ip  = is_string($_SERVER['REMOTE_ADDR'] ?? null) ? $_SERVER['REMOTE_ADDR'] : '';
        $key = 'bcge_quote_' . md5(wp_salt('nonce') . $ip);
        $hits = (int) get_transient($key);
        if ($hits >= self::RATE_LIMIT) {
            return false;
        }
        set_transient($key, $hits + 1, self::RATE_WINDOW);
        return true;
    }

    private static function valid_date($value) {
        $date = DateTimeImmutable::createFromFormat('!Y-m-d', (string) $value);
        return $date && $date->format('Y-m-d') === $value;
    }

    /** Coordinates within India, as autocomplete is restricted to India. */
    private static function point($lat, $lon) {
        if (!is_numeric($lat) || !is_numeric($lon)) {
            return null;
        }
        $lat = (float) $lat;
        $lon = (float) $lon;
        return ($lat >= 6 && $lat <= 38 && $lon >= 68 && $lon <= 98) ? array('lat' => $lat, 'lon' => $lon) : null;
    }

    private static function format_duration($seconds) {
        $minutes = (int) round($seconds / 60);
        $hours   = (int) floor($minutes / 60);
        return $hours ? sprintf('%d hr %d min', $hours, $minutes % 60) : sprintf('%d min', $minutes);
    }

    /** Driving distance from LocationIQ, cached so repeat quotes do not use the quota. */
    private static function road_distance($from, $to, $card) {
        $points = sprintf('%.3f,%.3f;%.3f,%.3f', $from['lon'], $from['lat'], $to['lon'], $to['lat']);
        $cache  = 'bcge_dist_' . md5($points);
        $cached = get_transient($cache);
        if (is_array($cached)) {
            return $cached;
        }

        $key = $card['server_key'] ?: (string) get_theme_mod('bc_location_key', '');
        if ($key === '') {
            return null;
        }
        $url = 'https://us1.locationiq.com/v1/directions/driving/' . $points . '?overview=false&key=' . rawurlencode($key);
        // The site's browser token is restricted by domain, so identify this site when using it.
        $response = wp_remote_get($url, array('timeout' => 6, 'headers' => array('Referer' => home_url('/'))));
        if (is_wp_error($response)) {
            error_log('BiharCabs quote: distance lookup failed (' . $response->get_error_code() . ')');
            return null;
        }
        $status = (int) wp_remote_retrieve_response_code($response);
        $body   = json_decode(wp_remote_retrieve_body($response), true);
        $route  = is_array($body) ? ($body['routes'][0] ?? null) : null;
        if ($status !== 200 || !is_array($route) || !is_numeric($route['distance'] ?? null) || $route['distance'] <= 0) {
            error_log('BiharCabs quote: unusable distance response (HTTP ' . $status . ')');
            return null;
        }

        $result = array('km' => round($route['distance'] / 1000, 1), 'duration_text' => self::format_duration((float) ($route['duration'] ?? 0)));
        set_transient($cache, $result, self::DISTANCE_TTL);
        return $result;
    }

    private static function vehicle_quote($code, $vehicle, $fare, $card) {
        return array_merge(array(
            'vehicle_code'     => $code,
            'vehicle_name'     => $vehicle['name'],
            'vehicle_models'   => $vehicle['models'],
            'seating_capacity' => (int) $vehicle['seats'],
            'luggage_bags'     => (int) $vehicle['bags'],
            'toll_tax_text'    => $card['toll_tax_text'],
        ), $fare);
    }

    public static function quote(WP_REST_Request $request) {
        $card = BCGE_Rate_Card::get();
        if (empty($card['public_enabled'])) {
            return self::fail('QUOTES_DISABLED', 'Fare estimates are not available yet.', 403);
        }
        if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 4096) {
            return self::fail('REQUEST_TOO_LARGE', 'Request is too large.', 413);
        }
        if (!self::within_rate_limit()) {
            return self::fail('RATE_LIMITED', 'Too many requests. Please try again shortly.', 429);
        }

        $params = $request->get_json_params();
        $params = is_array($params) ? $params : array();
        foreach (array('origin_city', 'destination_city') as $field) {
            if (isset($params[$field]) && (!is_string($params[$field]) || strlen($params[$field]) > 300)) {
                return self::fail('INVALID_REQUEST', 'Invalid location.', 400);
            }
        }
        $origin      = sanitize_text_field($params['origin_city'] ?? '');
        $destination = sanitize_text_field($params['destination_city'] ?? '');
        $trip_type   = is_string($params['trip_type'] ?? null) ? $params['trip_type'] : '';
        $pickup_date = is_string($params['pickup_date'] ?? null) ? $params['pickup_date'] : '';
        $return_date = is_string($params['return_date'] ?? null) ? $params['return_date'] : '';

        if ($origin === '' || !self::valid_date($pickup_date) || !in_array($trip_type, array('oneway', 'roundtrip', 'airport', 'local'), true)) {
            return self::fail('INVALID_REQUEST', 'Required fields: origin_city, trip_type, pickup_date.', 400);
        }
        // Local rentals are priced by packages, which the rate card does not hold yet.
        if ($trip_type === 'local' || $destination === '') {
            return self::fail('NO_TARIFF', 'Please contact us for a custom quote.');
        }

        $days = 1;
        if ($return_date !== '') {
            $days = self::valid_date($return_date) ? BCGE_Calculator::days_between($pickup_date, $return_date) : null;
            if ($days === null) {
                return self::fail('INVALID_REQUEST', 'Return date must be on or after the pickup date.', 400);
            }
        } elseif (isset($params['duration_days'])) {
            $days = (int) $params['duration_days'];
        }
        if ($days < 1 || $days > 60) {
            return self::fail('INVALID_REQUEST', 'Trip length must be between 1 and 60 days.', 400);
        }

        $route = BCGE_Calculator::find_route($card['routes'], $origin, $destination, $trip_type);
        $fixed = $route && ($trip_type !== 'roundtrip' || $days === 1);
        $km = BCGE_Calculator::known_distance($card['routes'], $origin, $destination);
        $duration_text = '';

        if ($km <= 0) {
            $from = self::point($params['origin_lat'] ?? null, $params['origin_lon'] ?? null);
            $to   = self::point($params['destination_lat'] ?? null, $params['destination_lon'] ?? null);
            $distance = ($from && $to) ? self::road_distance($from, $to, $card) : null;
            if ($distance) {
                $km = (float) $distance['km'];
                $duration_text = $distance['duration_text'];
            }
        }

        $quotes = array();
        $used_fixed = false;
        foreach ($card['vehicles'] as $code => $vehicle) {
            if (empty($vehicle['enabled'])) {
                continue;
            }
            $fare = $fixed ? BCGE_Calculator::fixed($route['fares'][$code] ?? '') : null;
            if ($fare) {
                $used_fixed = true;
            } elseif ($km > 0) {
                $fare = BCGE_Calculator::per_km($vehicle['rates'][$trip_type] ?? array(), $trip_type, $km, $days);
            }
            if ($fare) {
                $quotes[] = self::vehicle_quote($code, $vehicle, $fare, $card);
            }
        }

        if (!$quotes) {
            return self::fail('NO_TARIFF', 'Please contact us for a custom quote.');
        }

        return new WP_REST_Response(array(
            'success' => true,
            'route'   => array(
                'origin'          => $route['origin'] ?? $origin,
                'destination'     => $route['destination'] ?? $destination,
                'distance_km'     => $km,
                'duration_text'   => $duration_text,
                'is_fixed_tariff' => $used_fixed,
            ),
            'quotes'  => $quotes,
        ), 200);
    }
}
