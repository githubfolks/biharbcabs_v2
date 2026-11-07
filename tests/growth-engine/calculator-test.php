<?php
/** Pricing rule tests. Run from the repository root: php tests/growth-engine/calculator-test.php */
require __DIR__ . '/../../public_html/wp-content/plugins/biharcabs-growth-engine/includes/class-calculator.php';

$failed = 0;
function check($label, $actual, $expected) {
    global $failed;
    if ($actual === $expected) {
        echo "PASS $label\n";
        return;
    }
    $failed++;
    echo "FAIL $label: expected " . json_encode($expected) . ', got ' . json_encode($actual) . "\n";
}

// Sample numbers for checking arithmetic only; they are not real BiharCabs rates.
$rate = array('rate_per_km' => 10, 'min_km' => 100, 'driver_allowance' => 300);

$fare = BCGE_Calculator::per_km($rate, 'oneway', 150);
check('one way above minimum', $fare['total_fare'], 1800);
check('one way splits base and allowance', array($fare['base_fare'], $fare['driver_allowance']), array(1500, 300));
check('one way below minimum bills minimum km', BCGE_Calculator::per_km($rate, 'oneway', 40)['total_fare'], 1300);
check('one way at exactly minimum', BCGE_Calculator::per_km($rate, 'oneway', 100)['total_fare'], 1300);
check('airport follows one way rule', BCGE_Calculator::per_km($rate, 'airport', 150)['total_fare'], 1800);

check('round trip doubles distance', BCGE_Calculator::per_km($rate, 'roundtrip', 150, 1)['total_fare'], 3300);
check('round trip minimum applies', BCGE_Calculator::per_km($rate, 'roundtrip', 30, 1)['total_fare'], 1300);
check('round trip minimum is per day', BCGE_Calculator::per_km($rate, 'roundtrip', 150, 4)['total_fare'], 5200);
check('round trip allowance is per day', BCGE_Calculator::per_km($rate, 'roundtrip', 150, 3)['driver_allowance'], 900);
check('round trip with long distance ignores daily minimum', BCGE_Calculator::per_km($rate, 'roundtrip', 500, 2)['total_fare'], 10600);

check('fractional fare rounds to rupee', BCGE_Calculator::per_km(array('rate_per_km' => 12.5, 'min_km' => 0), 'oneway', 101.7)['total_fare'], 1271);
check('blank allowance counts as zero', BCGE_Calculator::per_km(array('rate_per_km' => 10, 'min_km' => '', 'driver_allowance' => ''), 'oneway', 50)['total_fare'], 500);

check('blank rate gives no price', BCGE_Calculator::per_km(array('rate_per_km' => ''), 'oneway', 100), null);
check('zero rate gives no price', BCGE_Calculator::per_km(array('rate_per_km' => 0), 'oneway', 100), null);
check('zero distance gives no price', BCGE_Calculator::per_km($rate, 'oneway', 0), null);
check('negative distance gives no price', BCGE_Calculator::per_km($rate, 'oneway', -5), null);

check('fixed fare is the total', BCGE_Calculator::fixed(2500)['total_fare'], 2500);
check('blank fixed fare gives no price', BCGE_Calculator::fixed(''), null);
check('zero fixed fare gives no price', BCGE_Calculator::fixed(0), null);

check('same-day trip is one day', BCGE_Calculator::days_between('2026-12-01', '2026-12-01'), 1);
check('dates count both ends', BCGE_Calculator::days_between('2026-12-01', '2026-12-03'), 3);
check('return before pickup rejected', BCGE_Calculator::days_between('2026-12-03', '2026-12-01'), null);

check('place key drops state', BCGE_Calculator::place_key('Gaya, Bihar, India'), 'gaya');
check('place key normalises case and spaces', BCGE_Calculator::place_key('  Bihar   Sharif '), 'bihar sharif');

$routes = array(
    array('origin' => 'Patna', 'destination' => 'Gaya', 'trip_type' => 'oneway', 'both_ways' => true),
    array('origin' => 'Patna', 'destination' => 'Rajgir', 'trip_type' => 'oneway', 'both_ways' => false),
);
check('route matches', BCGE_Calculator::find_route($routes, 'Patna', 'Gaya', 'oneway')['destination'], 'Gaya');
check('route matches full address', BCGE_Calculator::find_route($routes, 'Patna, Bihar, India', 'Gaya, Bihar', 'oneway')['destination'], 'Gaya');
check('both ways matches reverse', BCGE_Calculator::find_route($routes, 'Gaya', 'Patna', 'oneway')['origin'], 'Patna');
check('one direction rejects reverse', BCGE_Calculator::find_route($routes, 'Rajgir', 'Patna', 'oneway'), null);
check('trip type must match', BCGE_Calculator::find_route($routes, 'Patna', 'Gaya', 'roundtrip'), null);
check('street name is not the city', BCGE_Calculator::find_route($routes, 'Patna', 'Gaya Road, Patna', 'oneway'), null);
check('blank place never matches', BCGE_Calculator::find_route($routes, '', 'Gaya', 'oneway'), null);

$distances = array(
    array('origin' => 'Patna', 'destination' => 'Rajgir', 'trip_type' => 'oneway', 'distance_km' => 100.0, 'both_ways' => true),
    array('origin' => 'Patna', 'destination' => 'Gaya', 'trip_type' => 'oneway', 'distance_km' => '', 'both_ways' => false),
    array('origin' => 'Patna', 'destination' => 'Gaya', 'trip_type' => 'airport', 'distance_km' => 102.0, 'both_ways' => false),
);
check('known distance ignores trip type', BCGE_Calculator::known_distance($distances, 'Patna', 'Rajgir'), 100.0);
check('known distance follows both ways', BCGE_Calculator::known_distance($distances, 'Rajgir', 'Patna'), 100.0);
check('known distance skips rows with no distance', BCGE_Calculator::known_distance($distances, 'Patna', 'Gaya'), 102.0);
check('unknown route has no distance', BCGE_Calculator::known_distance($distances, 'Patna', 'Delhi'), 0.0);

echo $failed ? "\n$failed FAILED\n" : "\nALL PASSED\n";
exit($failed ? 1 : 0);
