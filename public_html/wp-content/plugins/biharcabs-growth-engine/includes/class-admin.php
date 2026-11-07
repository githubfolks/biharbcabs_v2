<?php
if (!defined('ABSPATH')) exit;

/** The Rate Card screen, where the owner sets prices without any code changes. */
class BCGE_Admin {
    const CAPABILITY = 'manage_options';

    public static function init() {
        add_action('admin_menu', array(__CLASS__, 'menu'));
        add_action('admin_post_bcge_save_rate_card', array(__CLASS__, 'save'));
    }

    public static function menu() {
        add_menu_page('Rate Card', 'Rate Card', self::CAPABILITY, 'bcge-rate-card', array(__CLASS__, 'render'), 'dashicons-money-alt', 27);
    }

    public static function save() {
        if (!current_user_can(self::CAPABILITY)) {
            wp_die('Permission denied.', 403);
        }
        check_admin_referer('bcge_save_rate_card', 'bcge_nonce');
        BCGE_Rate_Card::save(BCGE_Rate_Card::sanitize(wp_unslash($_POST)));
        wp_safe_redirect(add_query_arg(array('page' => 'bcge-rate-card', 'saved' => '1'), admin_url('admin.php')));
        exit;
    }

    private static function number_input($name, $value, $step = 'any') {
        printf('<input type="number" min="0" step="%s" class="small-text" name="%s" value="%s">', esc_attr($step), esc_attr($name), esc_attr((string) $value));
    }

    private static function route_row($index, $route, $vehicles) {
        $name = 'routes[' . $index . ']';
        echo '<tr>';
        printf('<td><input type="text" class="regular-text" style="width:130px" name="%s[origin]" value="%s"></td>', esc_attr($name), esc_attr($route['origin'] ?? ''));
        printf('<td><input type="text" class="regular-text" style="width:130px" name="%s[destination]" value="%s"></td>', esc_attr($name), esc_attr($route['destination'] ?? ''));
        printf('<td><select name="%s[trip_type]">', esc_attr($name));
        foreach (BCGE_Rate_Card::trip_types() as $key => $label) {
            printf('<option value="%s"%s>%s</option>', esc_attr($key), selected($route['trip_type'] ?? 'oneway', $key, false), esc_html($label));
        }
        echo '</select></td><td>';
        self::number_input($name . '[distance_km]', $route['distance_km'] ?? '');
        printf('</td><td style="text-align:center"><input type="checkbox" name="%s[both_ways]" value="1"%s></td>', esc_attr($name), checked(!empty($route['both_ways']), true, false));
        foreach (array_keys($vehicles) as $code) {
            echo '<td>';
            self::number_input($name . '[fares][' . $code . ']', $route['fares'][$code] ?? '', '1');
            echo '</td>';
        }
        echo '<td><button type="button" class="button-link bcge-remove">Remove</button></td></tr>';
    }

    public static function render() {
        if (!current_user_can(self::CAPABILITY)) {
            return;
        }
        $card = BCGE_Rate_Card::get();
        $vehicles = $card['vehicles'];
        $priced = 0;
        foreach ($vehicles as $vehicle) {
            foreach ($vehicle['rates'] as $rate) {
                $priced += is_numeric($rate['rate_per_km']) && $rate['rate_per_km'] > 0 ? 1 : 0;
            }
        }
        ?>
        <div class="wrap">
            <h1>Rate Card</h1>
            <?php if (isset($_GET['saved'])): ?>
                <div class="notice notice-success is-dismissible"><p>Rate card saved.</p></div>
            <?php endif; ?>
            <?php if (empty($card['public_enabled'])): ?>
                <div class="notice notice-warning"><p><strong>Fare estimates are switched off.</strong> Customers and the CRM see no prices until you enable them below.</p></div>
            <?php elseif (!$priced && !$card['routes']): ?>
                <div class="notice notice-warning"><p><strong>Estimates are on, but no rates are set,</strong> so customers will not see a price yet.</p></div>
            <?php endif; ?>
            <?php if (!empty($card['updated_at'])):
                $user = get_userdata((int) ($card['updated_by'] ?? 0)); ?>
                <p>Last changed <?php echo esc_html(wp_date('j M Y, g:i a', (int) $card['updated_at'])); ?><?php echo $user ? ' by ' . esc_html($user->display_name) : ''; ?>.</p>
            <?php endif; ?>

            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="bcge_save_rate_card">
                <?php wp_nonce_field('bcge_save_rate_card', 'bcge_nonce'); ?>

                <h2>Publishing</h2>
                <table class="form-table" role="presentation">
                    <tr><th scope="row">Fare estimates</th><td><label><input type="checkbox" name="public_enabled" value="1" <?php checked(!empty($card['public_enabled'])); ?>> Show estimates on the website and provide them to the CRM</label></td></tr>
                    <tr><th scope="row"><label for="bcge_toll">Toll note</label></th><td><input id="bcge_toll" type="text" class="regular-text" name="toll_tax_text" value="<?php echo esc_attr($card['toll_tax_text']); ?>"><p class="description">Shown next to every estimate.</p></td></tr>
                    <tr><th scope="row"><label for="bcge_states">Service area</label></th><td>
                        <textarea id="bcge_states" name="service_states" rows="5" class="regular-text"><?php echo esc_textarea(implode("\n", $card['service_states'])); ?></textarea>
                        <p class="description">One state per line, spelled as in maps (for example Uttar Pradesh). Leave empty for no limit. Routes listed below are always quoted.</p>
                        <p><label><input type="radio" name="service_area_rule" value="both" <?php checked($card['service_area_rule'], 'both'); ?>> Pickup and drop must both be in these states</label><br>
                        <label><input type="radio" name="service_area_rule" value="either" <?php checked($card['service_area_rule'], 'either'); ?>> Pickup or drop in these states is enough</label></p>
                        <p class="description">Other trips get no instant estimate; customers can still book and you quote them directly.</p>
                    </td></tr>
                    <tr><th scope="row"><label for="bcge_key">LocationIQ server token</label></th><td><input id="bcge_key" type="password" class="regular-text" autocomplete="off" name="server_key" value="<?php echo esc_attr($card['server_key']); ?>"><p class="description">Optional. Leave blank to use the website's LocationIQ token.</p></td></tr>
                </table>

                <h2>How fares are worked out</h2>
                <ul style="list-style:disc;margin-left:20px">
                    <li><strong>One way and airport:</strong> the higher of the distance or minimum km, multiplied by the rate, plus one driver allowance.</li>
                    <li><strong>Round trip:</strong> the higher of the distance &times; 2 or minimum km &times; days, multiplied by the rate, plus driver allowance &times; days.</li>
                    <li><strong>Fixed route fare:</strong> replaces the calculation for that route and vehicle. It is the full amount before tolls and parking.</li>
                    <li><strong>Blank rate:</strong> that vehicle is not shown. If no vehicle has a price, the customer is asked to contact you for a custom quote.</li>
                    <li><strong>Local rentals:</strong> always a custom quote for now.</li>
                </ul>

                <h2>Vehicles and per-km rates</h2>
                <?php foreach ($vehicles as $code => $vehicle):
                    $base = 'vehicles[' . $code . ']'; ?>
                    <h3><?php echo esc_html($vehicle['name']); ?> <code><?php echo esc_html($code); ?></code></h3>
                    <p>
                        <label><input type="checkbox" name="<?php echo esc_attr($base); ?>[enabled]" value="1" <?php checked(!empty($vehicle['enabled'])); ?>> Offer this vehicle</label>
                        &nbsp; <label>Name <input type="text" name="<?php echo esc_attr($base); ?>[name]" value="<?php echo esc_attr($vehicle['name']); ?>"></label>
                        &nbsp; <label>Models <input type="text" name="<?php echo esc_attr($base); ?>[models]" value="<?php echo esc_attr($vehicle['models']); ?>"></label>
                        &nbsp; <label>Seats <?php self::number_input($base . '[seats]', $vehicle['seats'], '1'); ?></label>
                        &nbsp; <label>Bags <?php self::number_input($base . '[bags]', $vehicle['bags'], '1'); ?></label>
                    </p>
                    <table class="widefat striped" style="max-width:640px">
                        <thead><tr><th>Trip type</th><th>Rate per km (₹)</th><th>Minimum km</th><th>Driver allowance (₹)</th></tr></thead>
                        <tbody>
                        <?php foreach (BCGE_Rate_Card::trip_types() as $trip => $label):
                            $rate = $vehicle['rates'][$trip]; $name = $base . '[rates][' . $trip . ']'; ?>
                            <tr>
                                <td><?php echo esc_html($label); ?><?php echo $trip === 'roundtrip' ? ' <small>(minimum and allowance are per day)</small>' : ''; ?></td>
                                <td><?php self::number_input($name . '[rate_per_km]', $rate['rate_per_km']); ?></td>
                                <td><?php self::number_input($name . '[min_km]', $rate['min_km']); ?></td>
                                <td><?php self::number_input($name . '[driver_allowance]', $rate['driver_allowance']); ?></td>
                            </tr>
                        <?php endforeach; ?>
                        </tbody>
                    </table>
                <?php endforeach; ?>

                <h2>Fixed routes</h2>
                <p class="description">Optional fixed fares for popular routes. Use the plain place name, such as Patna or Gaya. Add the distance so the route still works for the CRM and for vehicles without a fixed fare.</p>
                <table class="widefat striped" id="bcge-routes">
                    <thead><tr><th>From</th><th>To</th><th>Trip type</th><th>Distance km</th><th>Both ways</th>
                        <?php foreach ($vehicles as $vehicle): ?><th><?php echo esc_html($vehicle['name']); ?> ₹</th><?php endforeach; ?>
                        <th></th></tr></thead>
                    <tbody>
                    <?php foreach ($card['routes'] as $index => $route) { self::route_row($index, $route, $vehicles); } ?>
                    </tbody>
                </table>
                <template id="bcge-route-row"><?php self::route_row('__i__', array(), $vehicles); ?></template>
                <p><button type="button" class="button" id="bcge-add-route">Add route</button></p>

                <?php submit_button('Save rate card'); ?>
            </form>
        </div>
        <script>
        (function () {
            const body = document.querySelector('#bcge-routes tbody');
            const template = document.getElementById('bcge-route-row');
            let next = body.rows.length;
            document.getElementById('bcge-add-route').addEventListener('click', () => {
                const holder = document.createElement('tbody');
                holder.innerHTML = template.innerHTML.replace(/__i__/g, String(next++));
                body.appendChild(holder.firstElementChild);
            });
            body.addEventListener('click', event => {
                if (event.target.classList.contains('bcge-remove')) event.target.closest('tr').remove();
            });
        })();
        </script>
        <?php
    }
}
