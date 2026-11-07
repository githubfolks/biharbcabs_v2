<?php
/**
 * Biharcabs Booking & Lead Management System
 * Automatically captures leads from the booking form and contact form.
 */
if (!defined('ABSPATH')) exit;

/**
 * Register Custom Post Type for Bookings & Leads
 */
function bc_register_booking_cpt() {
    $labels = array(
        'name'                  => __('Bookings & Leads', 'biharcabs'),
        'singular_name'         => __('Booking', 'biharcabs'),
        'menu_name'             => __('Cab Bookings', 'biharcabs'),
        'name_admin_bar'        => __('Cab Booking', 'biharcabs'),
        'add_new'               => __('Add New Booking', 'biharcabs'),
        'add_new_item'          => __('Add New Booking', 'biharcabs'),
        'new_item'              => __('New Booking', 'biharcabs'),
        'edit_item'             => __('Edit Booking Details', 'biharcabs'),
        'view_item'             => __('View Booking', 'biharcabs'),
        'all_items'             => __('All Bookings & Leads', 'biharcabs'),
        'search_items'          => __('Search Bookings', 'biharcabs'),
        'not_found'             => __('No bookings found.', 'biharcabs'),
        'not_found_in_trash'    => __('No bookings found in Trash.', 'biharcabs')
    );

    $args = array(
        'labels'             => $labels,
        'public'             => false,
        'publicly_queryable' => false,
        'show_ui'            => true,
        'show_in_menu'       => true,
        'query_var'          => false,
        'rewrite'            => false,
        'capability_type'    => 'post',
        'has_archive'        => false,
        'hierarchical'       => false,
        'menu_position'      => 26,
        'menu_icon'          => 'dashicons-car',
        'supports'           => array('title')
    );

    register_post_type('bc_booking', $args);
}
add_action('init', 'bc_register_booking_cpt');

/**
 * Custom Admin Columns for Bookings List
 */
add_filter('manage_bc_booking_posts_columns', function($columns) {
    return array(
        'cb'            => $columns['cb'] ?? '<input type="checkbox" />',
        'title'         => __('Customer / ID', 'biharcabs'),
        'customer_phone'=> __('Phone Number', 'biharcabs'),
        'route'         => __('Route (Pickup → Drop)', 'biharcabs'),
        'travel_date'   => __('Travel Date & Time', 'biharcabs'),
        'trip_type'     => __('Trip Type', 'biharcabs'),
        'lead_source'   => __('Lead Source', 'biharcabs'),
        'booking_status'=> __('Status', 'biharcabs'),
        'actions'       => __('Quick Actions', 'biharcabs'),
        'date'          => __('Received On', 'biharcabs'),
    );
});

add_action('manage_bc_booking_posts_custom_column', function($column, $post_id) {
    $phone = get_post_meta($post_id, '_bc_phone', true);
    $pickup = get_post_meta($post_id, '_bc_pickup', true);
    $drop = get_post_meta($post_id, '_bc_drop', true);
    $date = get_post_meta($post_id, '_bc_date', true);
    $time = get_post_meta($post_id, '_bc_time', true);
    $category = get_post_meta($post_id, '_bc_category', true);
    $status = get_post_meta($post_id, '_bc_status', true) ?: 'New';
    $source = get_post_meta($post_id, '_bc_source', true) ?: 'Website Form';

    switch ($column) {
        case 'customer_phone':
            if ($phone) {
                echo '<a href="tel:' . esc_attr($phone) . '"><strong>' . esc_html($phone) . '</strong></a>';
            } else {
                echo '—';
            }
            break;

        case 'route':
            if ($pickup || $drop) {
                echo '<span style="color:#0284c7;font-weight:600;">' . esc_html($pickup ?: 'Not specified') . '</span>';
                echo ' <span style="color:#64748b;">→</span> ';
                echo '<span style="color:#16a34a;font-weight:600;">' . esc_html($drop ?: 'Not specified') . '</span>';
            } else {
                echo '—';
            }
            break;

        case 'travel_date':
            if ($date) {
                echo esc_html($date) . ($time ? ' @ ' . esc_html($time) : '');
            } else {
                echo '—';
            }
            break;

        case 'trip_type':
            echo esc_html($category ?: 'Standard');
            break;

        case 'lead_source':
            echo '<span class="badge" style="background:#f1f5f9;color:#334155;padding:3px 8px;border-radius:4px;font-size:11px;">' . esc_html($source) . '</span>';
            break;

        case 'booking_status':
            $colors = array(
                'New'        => '#eab308',
                'Contacted'  => '#3b82f6',
                'Confirmed'  => '#22c55e',
                'Cancelled'  => '#ef4444'
            );
            $bg = $colors[$status] ?? '#94a3b8';
            echo '<span style="background:' . esc_attr($bg) . ';color:#fff;padding:3px 10px;border-radius:12px;font-size:12px;font-weight:600;">' . esc_html($status) . '</span>';
            break;

        case 'actions':
            $clean_phone = preg_replace('/\D/', '', $phone);
            if ($clean_phone) {
                if (strlen($clean_phone) === 10) $clean_phone = '91' . $clean_phone;
                $wa_url = 'https://wa.me/' . $clean_phone . '?text=' . rawurlencode('Hello ' . get_the_title($post_id) . ', greetings from BiharCabs! Regarding your booking enquiry from ' . $pickup . ' to ' . $drop . '...');
                echo '<a href="' . esc_url($wa_url) . '" target="_blank" class="button button-small" style="background:#25d366;color:#fff;border-color:#22c55e;display:inline-flex;align-items:center;gap:4px;"><span class="dashicons dashicons-whatsapp" style="font-size:14px;line-height:22px;"></span> WhatsApp</a>';
            }
            break;
    }
}, 10, 2);

/**
 * Meta Box for Booking Details
 */
add_action('add_meta_boxes', function() {
    add_meta_box('bc_booking_meta', __('Booking & Customer Information', 'biharcabs'), 'bc_render_booking_meta_box', 'bc_booking', 'normal', 'high');
});

function bc_render_booking_meta_box($post) {
    wp_nonce_field('bc_save_booking_meta', 'bc_booking_meta_nonce');
    $fields = array(
        'name'         => get_the_title($post->ID),
        'phone'        => get_post_meta($post->ID, '_bc_phone', true),
        'email'        => get_post_meta($post->ID, '_bc_email', true),
        'pickup'       => get_post_meta($post->ID, '_bc_pickup', true),
        'drop'         => get_post_meta($post->ID, '_bc_drop', true),
        'date'         => get_post_meta($post->ID, '_bc_date', true),
        'time'         => get_post_meta($post->ID, '_bc_time', true),
        'passengers'   => get_post_meta($post->ID, '_bc_passengers', true),
        'category'     => get_post_meta($post->ID, '_bc_category', true),
        'distance'     => get_post_meta($post->ID, '_bc_distance', true),
        'instructions' => get_post_meta($post->ID, '_bc_instructions', true),
        'status'       => get_post_meta($post->ID, '_bc_status', true) ?: 'New',
        'source'       => get_post_meta($post->ID, '_bc_source', true) ?: 'Website Booking Form'
    );
    ?>
    <table class="form-table">
        <tr>
            <th><label for="bc_status"><strong>Booking Status</strong></label></th>
            <td>
                <select name="bc_status" id="bc_status" style="font-size:15px;font-weight:600;padding:4px 10px;">
                    <?php foreach (array('New', 'Contacted', 'Confirmed', 'Completed', 'Cancelled') as $st): ?>
                        <option value="<?php echo esc_attr($st); ?>" <?php selected($fields['status'], $st); ?>><?php echo esc_html($st); ?></option>
                    <?php endforeach; ?>
                </select>
            </td>
        </tr>
        <tr>
            <th><label>Customer Name</label></th>
            <td><input type="text" name="post_title" value="<?php echo esc_attr($fields['name']); ?>" class="regular-text" /></td>
        </tr>
        <tr>
            <th><label for="bc_phone">Phone Number</label></th>
            <td>
                <input type="text" id="bc_phone" name="bc_phone" value="<?php echo esc_attr($fields['phone']); ?>" class="regular-text" />
                <?php if ($fields['phone']): 
                    $clean = preg_replace('/\D/', '', $fields['phone']);
                    if (strlen($clean) === 10) $clean = '91' . $clean;
                ?>
                    <a href="https://wa.me/<?php echo esc_attr($clean); ?>" target="_blank" class="button" style="margin-left:8px;">Open WhatsApp Chat</a>
                    <a href="tel:<?php echo esc_attr($fields['phone']); ?>" class="button">Call Customer</a>
                <?php endif; ?>
            </td>
        </tr>
        <tr>
            <th><label for="bc_email">Email Address</label></th>
            <td><input type="email" id="bc_email" name="bc_email" value="<?php echo esc_attr($fields['email']); ?>" class="regular-text" /></td>
        </tr>
        <tr>
            <th><label for="bc_pickup">Pickup Location</label></th>
            <td><input type="text" id="bc_pickup" name="bc_pickup" value="<?php echo esc_attr($fields['pickup']); ?>" class="large-text" /></td>
        </tr>
        <tr>
            <th><label for="bc_drop">Drop Location</label></th>
            <td><input type="text" id="bc_drop" name="bc_drop" value="<?php echo esc_attr($fields['drop']); ?>" class="large-text" /></td>
        </tr>
        <tr>
            <th><label>Travel Schedule</label></th>
            <td>
                <label>Date: <input type="date" name="bc_date" value="<?php echo esc_attr($fields['date']); ?>" /></label>
                &nbsp;&nbsp;
                <label>Time: <input type="time" name="bc_time" value="<?php echo esc_attr($fields['time']); ?>" /></label>
            </td>
        </tr>
        <tr>
            <th><label for="bc_category">Trip Category & Type</label></th>
            <td><input type="text" id="bc_category" name="bc_category" value="<?php echo esc_attr($fields['category']); ?>" class="regular-text" /></td>
        </tr>
        <tr>
            <th><label for="bc_passengers">Passengers</label></th>
            <td><input type="text" id="bc_passengers" name="bc_passengers" value="<?php echo esc_attr($fields['passengers']); ?>" class="small-text" /></td>
        </tr>
        <tr>
            <th><label for="bc_distance">Estimated Distance</label></th>
            <td><input type="text" id="bc_distance" name="bc_distance" value="<?php echo esc_attr($fields['distance']); ?>" class="regular-text" /></td>
        </tr>
        <tr>
            <th><label for="bc_instructions">Customer Instructions / Notes</label></th>
            <td><textarea id="bc_instructions" name="bc_instructions" rows="4" class="large-text"><?php echo esc_textarea($fields['instructions']); ?></textarea></td>
        </tr>
        <tr>
            <th><label>Lead Source</label></th>
            <td><em><?php echo esc_html($fields['source']); ?></em></td>
        </tr>
    </table>
    <?php
}

add_action('save_post_bc_booking', function($post_id) {
    if (!isset($_POST['bc_booking_meta_nonce']) || !wp_verify_nonce($_POST['bc_booking_meta_nonce'], 'bc_save_booking_meta')) return;
    if (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) return;
    if (!current_user_can('edit_post', $post_id)) return;

    $fields = array('phone', 'email', 'pickup', 'drop', 'date', 'time', 'category', 'passengers', 'distance', 'instructions', 'status');
    foreach ($fields as $f) {
        if (isset($_POST['bc_' . $f])) {
            update_post_meta($post_id, '_bc_' . $f, sanitize_text_field(wp_unslash($_POST['bc_' . $f])));
        }
    }
});

/**
 * AJAX Endpoint: Capture Booking Lead to Database
 */
/**
 * Normalize an Indian mobile number to +91XXXXXXXXXX, or return '' if it is not one.
 * Mirrors the pattern set on booking phone inputs in biharcabs.js.
 */
function bc_normalize_mobile($raw) {
    if (!is_string($raw) || !preg_match('/^\s*\+?[0-9][0-9\s-]*$/D', $raw)) {
        return '';
    }
    $digits = preg_replace('/\D/', '', $raw);
    if (strlen($digits) === 12 && strpos($digits, '91') === 0) {
        $digits = substr($digits, 2);
    } elseif (strlen($digits) === 11 && $digits[0] === '0') {
        $digits = substr($digits, 1);
    }
    return preg_match('/^[6-9][0-9]{9}$/D', $digits) ? '+91' . $digits : '';
}

/**
 * Allow a burst of enquiries per IP rather than one: mobile carriers put many customers behind a
 * single IP, so a strict cooldown would silently drop real leads. Each slot is reserved atomically.
 */
function bc_acquire_booking_slot($ip, $limit = 10, $window = 600) {
    $key = hash_hmac('sha256', $ip, wp_salt('nonce'));
    for ($slot = 0; $slot < $limit; $slot++) {
        if (bc_acquire_contact_slot('booking:' . $key . ':' . $slot, $window)) {
            return true;
        }
    }
    return false;
}

function bc_ajax_save_booking() {
    if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) {
        wp_send_json_error(array('message' => 'Request is too large.'), 413);
    }
    foreach (array('pickup' => 500, 'drop' => 500, 'date' => 20, 'time' => 20, 'name' => 150, 'phone' => 40, 'passengers' => 40, 'category' => 80, 'distance' => 40, 'instructions' => 2000, 'source' => 80) as $field => $max) {
        if (isset($_POST[$field]) && (!is_string($_POST[$field]) || strlen(wp_unslash($_POST[$field])) > $max)) {
            wp_send_json_error(array('message' => 'Invalid or oversized form field.'), 400);
        }
    }

    $pickup       = sanitize_text_field(wp_unslash($_POST['pickup'] ?? ''));
    $drop         = sanitize_text_field(wp_unslash($_POST['drop'] ?? ''));
    $date         = sanitize_text_field(wp_unslash($_POST['date'] ?? ''));
    $time         = sanitize_text_field(wp_unslash($_POST['time'] ?? ''));
    $name         = sanitize_text_field(wp_unslash($_POST['name'] ?? ''));
    $phone        = bc_normalize_mobile(wp_unslash($_POST['phone'] ?? ''));
    $passengers   = sanitize_text_field(wp_unslash($_POST['passengers'] ?? '')) ?: '1';
    $category     = sanitize_text_field(wp_unslash($_POST['category'] ?? '')) ?: 'One Way';
    $distance     = sanitize_text_field(wp_unslash($_POST['distance'] ?? ''));
    $instructions = sanitize_textarea_field(wp_unslash($_POST['instructions'] ?? ''));
    $source       = sanitize_text_field(wp_unslash($_POST['source'] ?? '')) ?: 'Website Booking Form';

    if (empty($pickup) || empty($drop) || empty($phone)) {
        wp_send_json_error(array('message' => 'Please provide pickup, drop and a valid mobile number.'), 400);
    }

    $ip = is_string($_SERVER['REMOTE_ADDR'] ?? null) ? $_SERVER['REMOTE_ADDR'] : '';
    if (!bc_acquire_booking_slot($ip)) {
        header('Retry-After: 600');
        wp_send_json_error(array('message' => 'Too many requests. Please call or WhatsApp us.'), 429);
    }
    if (!wp_next_scheduled('bc_cleanup_contact_slots')) {
        wp_schedule_event(time() + HOUR_IN_SECONDS, 'daily', 'bc_cleanup_contact_slots');
    }

    $title = $name ?: ($phone ?: 'Booking Enquiry');
    if ($pickup && $drop) {
        $title .= ' (' . $pickup . ' → ' . $drop . ')';
    }

    $post_id = wp_insert_post(array(
        'post_type'   => 'bc_booking',
        'post_status' => 'publish',
        'post_title'  => $title,
    ));

    if (is_wp_error($post_id)) {
        wp_send_json_error(array('message' => $post_id->get_error_message()));
    }

    update_post_meta($post_id, '_bc_name', $name);
    update_post_meta($post_id, '_bc_phone', $phone);
    update_post_meta($post_id, '_bc_pickup', $pickup);
    update_post_meta($post_id, '_bc_drop', $drop);
    update_post_meta($post_id, '_bc_date', $date);
    update_post_meta($post_id, '_bc_time', $time);
    update_post_meta($post_id, '_bc_passengers', $passengers);
    update_post_meta($post_id, '_bc_category', $category);
    update_post_meta($post_id, '_bc_distance', $distance);
    update_post_meta($post_id, '_bc_instructions', $instructions);
    update_post_meta($post_id, '_bc_source', $source);
    update_post_meta($post_id, '_bc_status', 'New');

    // Optional admin email notification
    $recipient = bc_setting('contact_recipient') ?: get_option('admin_email');
    if ($recipient && is_email($recipient)) {
        $subject = 'New BiharCabs Booking Lead: ' . ($name ?: 'Customer') . ' (' . $pickup . ' to ' . $drop . ')';
        $body = "New Cab Booking Enquiry Received:\n\n"
              . "Name: $name\n"
              . "Phone: $phone\n"
              . "Pickup: $pickup\n"
              . "Drop: $drop\n"
              . "Date & Time: $date at $time\n"
              . "Category: $category\n"
              . "Passengers: $passengers\n"
              . "Est. Distance: $distance\n"
              . "Instructions: $instructions\n\n"
              . "View in Admin: " . admin_url('post.php?post=' . $post_id . '&action=edit') . "\n";
        @wp_mail($recipient, $subject, $body);
    }

    wp_send_json_success(array('message' => 'Booking saved successfully.', 'id' => $post_id));
}
add_action('wp_ajax_bc_save_booking', 'bc_ajax_save_booking');
add_action('wp_ajax_nopriv_bc_save_booking', 'bc_ajax_save_booking');

/**
 * Add Export Bookings to CSV functionality
 */
add_action('admin_menu', function() {
    add_submenu_page('edit.php?post_type=bc_booking', __('Export Bookings', 'biharcabs'), __('Export to CSV', 'biharcabs'), 'manage_options', 'bc-export-bookings', 'bc_export_bookings_page');
});

function bc_export_bookings_page() {
    ?>
    <div class="wrap">
        <h1><?php _e('Export Cab Bookings to CSV', 'biharcabs'); ?></h1>
        <p><?php _e('Download all customer booking leads, phone numbers, and trip details as an Excel/CSV file.', 'biharcabs'); ?></p>
        <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
            <input type="hidden" name="action" value="bc_download_bookings_csv">
            <?php wp_nonce_field('bc_export_csv', 'bc_csv_nonce'); ?>
            <?php submit_button(__('Download Bookings CSV', 'biharcabs'), 'primary'); ?>
        </form>
    </div>
    <?php
}

add_action('admin_post_bc_download_bookings_csv', function() {
    if (!current_user_can('manage_options')) wp_die(__('Permission denied.', 'biharcabs'));
    check_admin_referer('bc_export_csv', 'bc_csv_nonce');

    $posts = get_posts(array(
        'post_type'      => 'bc_booking',
        'post_status'    => 'publish',
        'numberposts'    => -1,
        'orderby'        => 'date',
        'order'          => 'DESC'
    ));

    header('Content-Type: text/csv; charset=utf-8');
    header('Content-Disposition: attachment; filename=biharcabs-bookings-' . date('Y-m-d') . '.csv');

    $output = fopen('php://output', 'w');
    fputcsv($output, array('ID', 'Date Received', 'Customer Name', 'Phone', 'Email', 'Pickup', 'Drop', 'Travel Date', 'Travel Time', 'Category', 'Passengers', 'Distance', 'Instructions', 'Status', 'Source'));

    foreach ($posts as $p) {
        fputcsv($output, array(
            $p->ID,
            $p->post_date,
            get_the_title($p->ID),
            get_post_meta($p->ID, '_bc_phone', true),
            get_post_meta($p->ID, '_bc_email', true),
            get_post_meta($p->ID, '_bc_pickup', true),
            get_post_meta($p->ID, '_bc_drop', true),
            get_post_meta($p->ID, '_bc_date', true),
            get_post_meta($p->ID, '_bc_time', true),
            get_post_meta($p->ID, '_bc_category', true),
            get_post_meta($p->ID, '_bc_passengers', true),
            get_post_meta($p->ID, '_bc_distance', true),
            get_post_meta($p->ID, '_bc_instructions', true),
            get_post_meta($p->ID, '_bc_status', true) ?: 'New',
            get_post_meta($p->ID, '_bc_source', true) ?: 'Website Form',
        ));
    }

    fclose($output);
    exit;
});

/**
 * Shortcode: Instant Booking Request Form
 * Usage: [biharcabs_booking] or [biharcabs_instant_booking] or [biharcabs_booking_form]
 */
function bc_instant_booking_shortcode($atts) {
    $atts = shortcode_atts(array(
        'title'        => __('Instant Booking Request', 'biharcabs'),
        'subtitle'     => __("We'll reply with exact fare & confirm in 2 minutes!", 'biharcabs'),
        'button_text'  => __('Send Booking on WhatsApp', 'biharcabs'),
        'show_card'    => 'yes',
        'source'       => 'Shortcode Booking Form'
    ), $atts, 'biharcabs_booking');

    // Ensure assets are loaded
    wp_enqueue_style('bc-bootstrap.min');
    wp_enqueue_style('bc-all-fontawesome.min');
    wp_enqueue_style('bc-style');
    wp_enqueue_script('bc-main');
    wp_enqueue_script('biharcabs');

    $uniq = uniqid('bc_');
    $phone = bc_phone(bc_setting('phone'));
    $wa = bc_digits(bc_setting('whatsapp'));

    ob_start();
    ?>
    <div class="bc-shortcode-booking-wrapper <?php echo $atts['show_card'] === 'yes' ? 'booking-form-card' : ''; ?>" style="max-width:760px;margin:25px auto;background:#fff;padding:28px 24px;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,0.06);border:1px solid #f1f5f9;box-sizing:border-box;">
        <?php if (!empty($atts['title'])): ?>
            <h4 class="fw-bold mb-4" style="font-family:'Outfit',sans-serif;color:#111827;font-size:22px;display:flex;align-items:center;gap:10px;">
                <?php echo esc_html($atts['title']); ?>
            </h4>
        <?php endif; ?>
        <form data-bc-booking="true" data-bc-source="<?php echo esc_attr($atts['source']); ?>" class="bc-booking-form-instant" action="#">
            <div class="row g-3">
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Your Name <span style="color:#ef4444;">*</span></label>
                    <input type="text" data-bc-field="name" class="custom-input form-control" placeholder="Enter full name" required style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                </div>
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Phone Number <span style="color:#ef4444;">*</span></label>
                    <input type="tel" data-bc-field="phone" class="custom-input form-control" placeholder="+91 Mobile Number" required style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                </div>
                <div class="col-md-6 position-relative">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Pickup Location <span style="color:#ef4444;">*</span></label>
                    <input type="text" id="pickup_location_<?php echo esc_attr($uniq); ?>" data-bc-field="pickup" class="custom-input form-control pe-5" placeholder="Type pickup spot or city..." required style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                    <i class="fas fa-crosshairs text-primary position-absolute" id="auto_detect_btn_<?php echo esc_attr($uniq); ?>" data-bc-field="auto" style="right:25px;top:40px;cursor:pointer;font-size:18px;z-index:10;" title="Auto Detect Location"></i>
                </div>
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Drop Location <span style="color:#ef4444;">*</span></label>
                    <input type="text" id="drop_location_<?php echo esc_attr($uniq); ?>" data-bc-field="drop" class="custom-input form-control" placeholder="Type drop destination or city..." required style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                </div>
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Travel Date <span style="color:#ef4444;">*</span></label>
                    <input type="date" data-bc-field="date" class="custom-input form-control" required style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                </div>
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Pickup Time <span style="color:#ef4444;">*</span></label>
                    <input type="time" data-bc-field="time" class="custom-input form-control" required style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                </div>
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Total Passengers <span style="color:#ef4444;">*</span></label>
                    <select data-bc-field="passengers" class="custom-input custom-select form-select" style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                        <option>1 Person</option>
                        <option>2 Persons</option>
                        <option>3 Persons</option>
                        <option>4 Persons</option>
                        <option>5+ Persons</option>
                    </select>
                </div>
                <div class="col-md-6">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Trip Category <span style="color:#ef4444;">*</span></label>
                    <select data-bc-field="category" class="custom-input custom-select form-select" style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                        <option>One Way (Drop)</option>
                        <option>Round Trip</option>
                        <option>Local Rental</option>
                        <option>Airport Transfer</option>
                    </select>
                </div>
                <div class="col-12">
                    <label class="form-label-custom" style="display:block;margin-bottom:6px;font-weight:600;font-size:13px;color:#374151;">Special Instructions / Luggage (Optional)</label>
                    <input type="text" data-bc-field="instructions" class="custom-input form-control" placeholder="e.g. AC Sedan required, 3 big suitcases" style="border-radius:10px;padding:12px;border:1px solid #e5e7eb;width:100%;font-size:14px;">
                </div>
                <div class="col-12 mt-4">
                    <div id="fare_estimate_box_<?php echo esc_attr($uniq); ?>" data-bc-field="estimate" class="mb-3 p-3 rounded text-center" style="display:none;background:rgba(250,204,21,0.12);border:1px dashed #facc15;border-radius:10px;">
                        <small class="text-muted text-uppercase fw-bold" style="letter-spacing:1px;font-size:11px;">Total Driving Distance</small>
                        <div class="mt-1">
                            <i class="fas fa-route text-warning me-2" style="font-size:20px;"></i>
                            <strong data-bc-field="distance" class="text-dark" style="font-size:24px;">-</strong>
                        </div>
                        <small class="text-muted mt-2 d-block" style="font-size:11px;">*Our team will contact you shortly with the best fare for this trip.</small>
                    </div>

                    <button type="submit" class="btn-whatsapp-submit btn w-100" style="background:#25d366;color:#fff;font-weight:bold;padding:14px;border-radius:12px;font-size:16px;border:none;box-shadow:0 4px 14px rgba(37,211,102,0.3);display:flex;align-items:center;justify-content:center;gap:8px;cursor:pointer;">
                        <i class="fab fa-whatsapp" style="font-size:20px;"></i> <?php echo esc_html($atts['button_text']); ?>
                    </button>
                    <?php if (!empty($atts['subtitle'])): ?>
                        <p class="text-center text-muted mt-3 mb-0" style="font-size:12px;font-weight:600;"><?php echo esc_html($atts['subtitle']); ?></p>
                    <?php endif; ?>
                </div>
            </div>
        </form>
    </div>
    <?php
    return ob_get_clean();
}
add_shortcode('biharcabs_booking', 'bc_instant_booking_shortcode');
add_shortcode('biharcabs_instant_booking', 'bc_instant_booking_shortcode');
add_shortcode('biharcabs_booking_form', 'bc_instant_booking_shortcode');

