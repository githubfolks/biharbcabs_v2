<?php
/**
 * Biharcabs Demo Content & Page Importer
 */
if (!defined('ABSPATH')) exit;

function bc_demo_pages() {
    return array(
        'index'   => 'Home',
        'service' => 'Services',
        'cities'  => 'Cities',
        'about'   => 'About Us',
        'contact' => 'Contact Us',
        'fares'   => 'Taxi Fares',
        'blog'    => 'Blog & News'
    );
}

function bc_demo_page($key) {
    $slug = $key === 'index' ? 'home' : $key;
    $page = get_page_by_path($slug, OBJECT, array('page'));
    if (!$page) {
        $mapped = get_posts(array(
            'post_type'   => 'page',
            'post_status' => array('publish', 'draft', 'pending', 'private', 'future'),
            'numberposts' => 1,
            'meta_key'    => '_bc_demo_page',
            'meta_value'  => $key
        ));
        $page = $mapped ? $mapped[0] : null;
    }
    return $page;
}

function bc_demo_has_builder_content($id) {
    $data = get_post_meta($id, '_elementor_data', true);
    if (is_string($data)) $data = json_decode($data, true);
    return !empty($data);
}

function bc_demo_status($key, $page) {
    if (!$page) return 'Missing — will be created';
    if ($page->post_status !== 'publish') return ucfirst($page->post_status) . ' — review and publish this page';
    if (get_post_meta($page->ID, '_bc_native_elementor', true)) return 'Fully Editable Elementor page ready';
    if (bc_demo_has_legacy_widget($page->ID)) return 'Legacy widget — click Convert below for direct editing';
    if ($key === 'blog') return 'Ready — WordPress posts page';
    if (!trim($page->post_content) && !bc_demo_has_builder_content($page->ID)) return 'Empty — demo content will be added';
    if (get_post_meta($page->ID, '_bc_demo_page', true) === $key) return 'Demo page ready';
    return 'Existing content — preserved';
}

function bc_demo_elementor_data($key) {
    return bc_native_data($key);
}

/**
 * Setup default navigation menu with imported pages
 */
function bc_setup_default_nav_menu($ids) {
    $menu_name = 'Biharcabs Main Navigation';
    $menu_obj = wp_get_nav_menu_object($menu_name);
    $menu_id = $menu_obj ? $menu_obj->term_id : wp_create_nav_menu($menu_name);

    if ($menu_id && !is_wp_error($menu_id)) {
        $existing_items = wp_get_nav_menu_items($menu_id);
        if (empty($existing_items)) {
            $order = 1;
            foreach (array('index', 'service', 'cities', 'about', 'fares', 'contact', 'blog') as $key) {
                if (empty($ids[$key])) continue;
                $page_id = $ids[$key];
                wp_update_nav_menu_item($menu_id, 0, array(
                    'menu-item-title'     => get_the_title($page_id),
                    'menu-item-object'    => 'page',
                    'menu-item-object-id' => $page_id,
                    'menu-item-type'      => 'post_type',
                    'menu-item-status'    => 'publish',
                    'menu-item-position'  => $order++
                ));
            }
        }
        $locations = get_theme_mod('nav_menu_locations', array());
        $locations['primary'] = $menu_id;
        $locations['footer']  = $menu_id;
        set_theme_mod('nav_menu_locations', $locations);
    }
}

/**
 * Repeatable Importer
 */
function bc_import_demo_pages($elementor = true, $set_front = true) {
    if (!current_user_can('edit_theme_options') || !current_user_can('publish_pages') || ($set_front && !current_user_can('manage_options'))) {
        return new WP_Error('bc_forbidden', 'Permission denied.');
    }

    // Auto-enable Elementor container experiment if Elementor is loaded
    if (did_action('elementor/loaded') || class_exists('\Elementor\Plugin')) {
        update_option('elementor_experiment-container', 'active');
    }

    $results = array();
    $ids = array();

    foreach (bc_demo_pages() as $key => $title) {
        $id = 0;
        try {
            $page = bc_demo_page($key);
            $slug = $key === 'index' ? 'home' : $key;
            $shortcode = $key === 'blog' ? '' : '[biharcabs_demo page="' . $key . '"]';
            $status = 'existing';
            $write_demo = false;

            if (!$page) {
                // Insert page with clean initial content
                $id = wp_insert_post(array(
                    'post_type'    => 'page',
                    'post_status'  => 'publish',
                    'post_title'   => $title,
                    'post_name'    => $slug,
                    'post_content' => $shortcode
                ), true);

                if (is_wp_error($id)) {
                    $results[$key] = array('status' => 'error', 'message' => $id->get_error_message(), 'id' => 0);
                    continue;
                }
                if (!$id) throw new RuntimeException('WordPress did not return a page ID.');
                $page = get_post($id);
                $write_demo = true;
                $status = 'created';
            } else {
                $id = $page->ID;
                if ($page->post_status !== 'publish') {
                    $results[$key] = array('status' => 'review', 'message' => 'Existing ' . get_post_status($id) . ' page was preserved. Publish it to make it visible.', 'id' => $id);
                    $ids[$key] = $id;
                    continue;
                }
                if ($key !== 'blog' && !trim($page->post_content) && !bc_demo_has_builder_content($id)) {
                    if (!current_user_can('edit_post', $id)) throw new RuntimeException('You cannot edit this existing page.');
                    $saved = wp_update_post(array('ID' => $id, 'post_content' => $shortcode), true);
                    if (is_wp_error($saved)) throw new RuntimeException($saved->get_error_message());
                    $write_demo = true;
                    $status = 'repaired';
                }
            }

            update_post_meta($id, '_bc_demo_page', $key);

            // Convert to native Elementor if Elementor is available
            $can_elementor = did_action('elementor/loaded') || class_exists('\Elementor\Plugin');
            $untouched = bc_native_is_untouched_legacy($id, $key);

            if ($can_elementor && ($write_demo || $untouched || $elementor) && current_user_can('edit_post', $id)) {
                $saved = bc_native_save($id, $key, !$write_demo);
                if (!is_wp_error($saved)) {
                    if ($status === 'existing') $status = 'converted';
                }
            }

            $ids[$key] = $id;
            $messages = array(
                'created'   => 'Demo page created and configured for Elementor.',
                'repaired'  => 'Demo content added and repaired for Elementor.',
                'converted' => 'Page converted to 100% editable Elementor sections.',
                'existing'  => 'Existing page preserved.'
            );
            $results[$key] = array('status' => $status, 'message' => $messages[$status] ?? 'Ready.', 'id' => $id);
        } catch (Throwable $error) {
            $results[$key] = array('status' => 'error', 'message' => $error->getMessage(), 'id' => (int) $id);
        }
    }

    // Set Front Page and Posts Page
    if ($set_front && isset($ids['index'])) {
        update_option('show_on_front', 'page');
        update_option('page_on_front', $ids['index']);
        if (isset($ids['blog'])) {
            $is_native = get_post_meta($ids['blog'], '_bc_native_elementor', true);
            update_option('page_for_posts', $is_native ? 0 : $ids['blog']);
        }
    }

    // Automatically create and set primary navigation menu if not already set
    if (!empty($ids)) {
        bc_setup_default_nav_menu($ids);
    }

    if (did_action('elementor/loaded') || class_exists('\Elementor\Plugin')) {
        bc_install_blog_templates();
    }

    return $results;
}

add_action('admin_menu', function() {
    add_theme_page('Biharcabs Setup', 'Biharcabs Setup', 'edit_theme_options', 'biharcabs-setup', 'bc_setup_screen');
});

add_action('admin_notices', function() {
    if (!current_user_can('edit_theme_options') || !current_user_can('publish_pages')) return;
    if (isset($_GET['page']) && $_GET['page'] === 'biharcabs-setup') return;

    $missing = 0;
    foreach (bc_demo_pages() as $key => $title) {
        $p = bc_demo_page($key);
        if (!$p || ($key !== 'blog' && !trim($p->post_content) && !bc_demo_has_builder_content($p->ID))) {
            $missing++;
        }
    }
    if (!$missing && get_option('page_on_front')) return;

    echo '<div class="notice notice-warning is-dismissible" style="padding:14px 18px;border-left:4px solid #facc15;"><p style="font-size:14px;margin:0;"><strong>Biharcabs Theme:</strong> Demo setup is required to make pages directly editable in Elementor. <a href="' . esc_url(admin_url('themes.php?page=biharcabs-setup')) . '" class="button button-primary" style="margin-left:10px;">Setup / Import Editable Pages</a></p></div>';
});

function bc_setup_screen() {
    if (!current_user_can('edit_theme_options')) return;
    $results = get_transient('bc_import_result_' . get_current_user_id());
    $elementor_active = did_action('elementor/loaded') > 0 || class_exists('\Elementor\Plugin');
    ?>
    <div class="wrap">
        <h1>Biharcabs Theme Setup & Page Manager</h1>
        <p style="font-size:15px;color:#475569;">Import, repair, and convert your website demo pages into <strong>100% editable Elementor sections</strong>.</p>

        <?php if (!$elementor_active): ?>
            <div class="notice notice-info" style="padding:12px;border-left:4px solid #3b82f6;">
                <p><strong>Recommendation:</strong> Install and activate the free <a href="<?php echo esc_url(admin_url('plugin-install.php?s=elementor&tab=search&type=term')); ?>"><strong>Elementor</strong></a> plugin to enable visual drag-and-drop editing of your cab booking site.</p>
            </div>
        <?php endif; ?>

        <?php if (is_array($results)):
            $problems = array_filter($results, function($row) { return in_array($row['status'], array('error', 'review'), true); }); ?>
            <div class="notice <?php echo $problems ? 'notice-warning' : 'notice-success'; ?>">
                <p><strong><?php echo $problems ? 'Setup finished with items to check.' : 'Success! All demo pages are created and ready for editing.'; ?></strong></p>
            </div>
        <?php endif; ?>

        <div style="background:#fff;border:1px solid #cbd5e1;padding:20px;border-radius:8px;margin:20px 0;max-width:900px;box-shadow:0 1px 3px rgba(0,0,0,0.05);">
            <h2 style="margin-top:0;">One-Click Demo Setup</h2>
            <p>Clicking the button below will:</p>
            <ul style="list-style:disc;padding-left:20px;color:#334155;line-height:1.7;">
                <li>Create all 7 pages: <strong>Home, Services, Cities, About Us, Contact, Fares, Blog</strong>.</li>
                <li>Convert them into <strong>native, editable Elementor sections</strong> with booking forms.</li>
                <li>Set the demo Home page as your official <strong>WordPress Homepage</strong>.</li>
                <li>Create and assign the <strong>Header & Footer Navigation Menu</strong>.</li>
                <li>Activate Elementor Flexbox Container experiment automatically.</li>
            </ul>

            <form method="post" action="<?php echo esc_url(admin_url('admin-post.php')); ?>">
                <input type="hidden" name="action" value="bc_import_demo">
                <?php wp_nonce_field('bc_import_demo'); ?>
                <input type="hidden" name="set_front" value="1">
                <input type="hidden" name="elementor" value="1">
                <p>
                    <button type="submit" class="button button-primary button-hero" style="background:#facc15;border-color:#eab308;color:#000;font-weight:bold;">
                        ⚡ Import & Configure All 7 Pages for Elementor
                    </button>
                </p>
            </form>
        </div>

        <h2>Page Status & Direct Edit Links</h2>
        <table class="widefat striped" style="max-width:1100px;">
            <thead>
                <tr>
                    <th style="width:16%;">Page Title</th>
                    <th style="width:25%;">Current Status</th>
                    <th style="width:25%;">Last Setup Message</th>
                    <th>Actions</th>
                </tr>
            </thead>
            <tbody>
                <?php foreach (bc_demo_pages() as $key => $title): $page = bc_demo_page($key); ?>
                    <tr id="bc-demo-<?php echo esc_attr($key); ?>">
                        <td><strong><?php echo esc_html($title); ?></strong></td>
                        <td><?php echo esc_html(bc_demo_status($key, $page)); ?></td>
                        <td><?php echo esc_html($results[$key]['message'] ?? 'Ready in system.'); ?></td>
                        <td>
                            <?php if ($page): ?>
                                <a class="button button-small" href="<?php echo esc_url(get_edit_post_link($page->ID)); ?>">Edit (WP)</a>
                                <?php if ($elementor_active && current_user_can('edit_post', $page->ID)): ?>
                                    <a class="button button-small button-primary" style="background:#9333ea;border-color:#7e22ce;color:#fff;" href="<?php echo esc_url(admin_url('post.php?post=' . $page->ID . '&action=elementor')); ?>">Edit with Elementor</a>
                                    <?php if (!get_post_meta($page->ID, '_bc_native_elementor', true) && current_user_can('manage_options')): ?>
                                        <div style="display:inline-block;margin-left:6px;">
                                            <?php bc_native_action_form($page->ID, $key, 'convert', 'Convert to Elementor Sections'); ?>
                                        </div>
                                    <?php endif; ?>
                                <?php endif; ?>
                                <?php if ($page->post_status === 'publish'): ?>
                                    <a class="button button-small" href="<?php echo esc_url(get_permalink($page)); ?>" target="_blank" rel="noopener noreferrer">View Live ↗</a>
                                <?php endif; ?>
                            <?php else: ?>
                                <span style="color:#ef4444;font-size:12px;">Not Created</span>
                            <?php endif; ?>
                        </td>
                    </tr>
                <?php endforeach; ?>
            </tbody>
        </table>

        <div style="margin-top:30px;max-width:900px;">
            <h3>Quick Links & Settings</h3>
            <p>
                <a class="button" href="<?php echo esc_url(admin_url('edit.php?post_type=bc_booking')); ?>"><strong>View Cab Bookings & Leads</strong></a>
                <a class="button" href="<?php echo esc_url(admin_url('customize.php')); ?>">Customize Logo & Theme Colors</a>
                <a class="button" href="<?php echo esc_url(admin_url('nav-menus.php')); ?>">Edit Navigation Menus</a>
                <a class="button" href="<?php echo esc_url(admin_url('options-reading.php')); ?>">Reading Settings</a>
            </p>
        </div>
    </div>
    <?php
}

add_action('admin_post_bc_import_demo', function() {
    if (!current_user_can('edit_theme_options') || !current_user_can('publish_pages')) {
        wp_die('Permission denied.', '', array('response' => 403));
    }
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        wp_die('POST required.', '', array('response' => 405));
    }
    check_admin_referer('bc_import_demo');

    $results = bc_import_demo_pages(true, true);
    if (is_wp_error($results)) {
        wp_die(esc_html($results->get_error_message()), '', array('response' => 403));
    }
    set_transient('bc_import_result_' . get_current_user_id(), $results, HOUR_IN_SECONDS);
    wp_safe_redirect(admin_url('themes.php?page=biharcabs-setup'));
    exit;
});

function bc_demo_has_legacy_widget($id) {
    $data = get_post_meta($id, '_elementor_data', true);
    $queue = is_string($data) ? json_decode($data, true) : $data;
    if (!is_array($queue)) return false;
    $checked = 0;
    while ($queue && $checked++ < 10000) {
        $node = array_pop($queue);
        if (!is_array($node)) continue;
        if (($node['widgetType'] ?? '') === 'biharcabs-demo') return true;
        foreach ((array) ($node['elements'] ?? array()) as $child) $queue[] = $child;
    }
    return false;
}
