<?php
if (!defined('ABSPATH')) exit;

/** Storage and validation for the rate card. Rates start blank: nothing is priced until the owner enters it. */
class BCGE_Rate_Card {
    const OPTION  = 'bcge_rate_card';
    const HISTORY = 'bcge_rate_card_history';
    const HISTORY_LIMIT = 20;

    /** both: pickup and drop must be in the service area. either: one end is enough. */
    public static function area_rules() {
        return array('both', 'either');
    }

    public static function trip_types() {
        return array('oneway' => 'One way', 'roundtrip' => 'Round trip', 'airport' => 'Airport transfer');
    }

    public static function defaults() {
        // Codes match wp_vehicle_code in the CRM. Details are as advertised on the site.
        $vehicle = function ($name, $models, $seats, $bags) {
            $blank = array('rate_per_km' => '', 'min_km' => '', 'driver_allowance' => '');
            return array('name' => $name, 'models' => $models, 'seats' => $seats, 'bags' => $bags, 'enabled' => true,
                'rates' => array('oneway' => $blank, 'roundtrip' => $blank, 'airport' => $blank));
        };
        return array(
            'public_enabled' => false,
            'toll_tax_text'  => 'Toll and parking extra',
            'server_key'     => '',
            // Names exactly as LocationIQ reverse geocoding returns them. An empty list means no limit.
            'service_states'    => array('Bihar', 'West Bengal', 'Jharkhand', 'Assam', 'Uttar Pradesh'),
            'service_area_rule' => 'both',
            'vehicles'       => array(
                'sedan'  => $vehicle('Sedan', 'Swift / Dzire / Etios', 4, 2),
                'ertiga' => $vehicle('Ertiga SUV', 'Ertiga', 6, 4),
                'innova' => $vehicle('Innova Crysta', 'Innova / Crysta', 7, 4),
                'tempo'  => $vehicle('Tempo Traveller', '13 / 17 / 26 seater', 13, 10),
            ),
            'routes' => array(),
        );
    }

    public static function get() {
        $saved = get_option(self::OPTION);
        if (!is_array($saved)) {
            return self::defaults();
        }
        $card = array_merge(self::defaults(), $saved);
        foreach (self::defaults()['vehicles'] as $code => $vehicle) {
            if (!isset($card['vehicles'][$code])) {
                $card['vehicles'][$code] = $vehicle;
            }
        }
        return $card;
    }

    /** Save a validated card, keeping the previous version so every price change can be traced. */
    public static function save($card) {
        $previous = get_option(self::OPTION);
        if (is_array($previous)) {
            $history = get_option(self::HISTORY, array());
            $history = is_array($history) ? $history : array();
            array_unshift($history, array('card' => $previous));
            update_option(self::HISTORY, array_slice($history, 0, self::HISTORY_LIMIT), false);
        }
        $card['updated_at'] = time();
        $card['updated_by'] = get_current_user_id();
        update_option(self::OPTION, $card, false);
    }

    private static function amount($value) {
        $value = is_scalar($value) ? trim((string) $value) : '';
        return ($value !== '' && is_numeric($value) && (float) $value >= 0) ? (float) $value : '';
    }

    /** Build a clean card from the raw (already unslashed) form post. */
    public static function sanitize($post) {
        $base = self::defaults();
        $card = array(
            'public_enabled' => !empty($post['public_enabled']),
            'toll_tax_text'  => mb_substr(sanitize_text_field($post['toll_tax_text'] ?? ''), 0, 120),
            'server_key'     => sanitize_text_field($post['server_key'] ?? ''),
            'service_states' => array(),
            'service_area_rule' => in_array($post['service_area_rule'] ?? '', self::area_rules(), true) ? $post['service_area_rule'] : 'both',
            'vehicles'       => array(),
            'routes'         => array(),
        );
        $states = preg_split('/[\r\n,]+/', (string) ($post['service_states'] ?? ''));
        foreach (array_slice($states, 0, 40) as $state) {
            $state = mb_substr(sanitize_text_field($state), 0, 60);
            if ($state !== '' && !in_array($state, $card['service_states'], true)) {
                $card['service_states'][] = $state;
            }
        }

        foreach ($base['vehicles'] as $code => $defaults) {
            $raw = is_array($post['vehicles'][$code] ?? null) ? $post['vehicles'][$code] : array();
            $vehicle = array(
                'name'    => mb_substr(sanitize_text_field($raw['name'] ?? '') ?: $defaults['name'], 0, 60),
                'models'  => mb_substr(sanitize_text_field($raw['models'] ?? ''), 0, 80),
                'seats'   => max(1, absint($raw['seats'] ?? $defaults['seats'])),
                'bags'    => absint($raw['bags'] ?? $defaults['bags']),
                'enabled' => !empty($raw['enabled']),
                'rates'   => array(),
            );
            foreach (array_keys(self::trip_types()) as $trip) {
                $rate = is_array($raw['rates'][$trip] ?? null) ? $raw['rates'][$trip] : array();
                $vehicle['rates'][$trip] = array(
                    'rate_per_km'      => self::amount($rate['rate_per_km'] ?? ''),
                    'min_km'           => self::amount($rate['min_km'] ?? ''),
                    'driver_allowance' => self::amount($rate['driver_allowance'] ?? ''),
                );
            }
            $card['vehicles'][$code] = $vehicle;
        }

        $routes = is_array($post['routes'] ?? null) ? $post['routes'] : array();
        foreach (array_slice($routes, 0, 500) as $raw) {
            if (!is_array($raw)) {
                continue;
            }
            $origin = mb_substr(sanitize_text_field($raw['origin'] ?? ''), 0, 80);
            $destination = mb_substr(sanitize_text_field($raw['destination'] ?? ''), 0, 80);
            $trip = (string) ($raw['trip_type'] ?? '');
            if ($origin === '' || $destination === '' || !isset(self::trip_types()[$trip])) {
                continue;
            }
            $fares = array();
            foreach (array_keys($base['vehicles']) as $code) {
                $fares[$code] = self::amount($raw['fares'][$code] ?? '');
            }
            $card['routes'][] = array(
                'origin'      => $origin,
                'destination' => $destination,
                'trip_type'   => $trip,
                'distance_km' => self::amount($raw['distance_km'] ?? ''),
                'both_ways'   => !empty($raw['both_ways']),
                'fares'       => $fares,
            );
        }
        return $card;
    }
}
