<?php
/**
 * Biharcabs Front Page Template
 */
if (!defined('ABSPATH')) exit;

get_header();
echo '<main id="main-content" class="main bc-main-wrap">';

// 1. If a static page is assigned and WordPress query has the post, render it
if (is_page() && have_posts()) {
    while (have_posts()) {
        the_post();
        the_content();
    }
} else {
    // 2. Fallback: check if an imported 'home' demo page exists in database
    $home_page = get_page_by_path('home', OBJECT, 'page');
    if (!$home_page) {
        $mapped = get_posts(array(
            'post_type'   => 'page',
            'post_status' => 'publish',
            'numberposts' => 1,
            'meta_key'    => '_bc_demo_page',
            'meta_value'  => 'index'
        ));
        $home_page = $mapped ? $mapped[0] : null;
    }

    if ($home_page) {
        // If logged in as admin, show helpful banner
        if (current_user_can('manage_options') && get_option('show_on_front') !== 'page') {
            echo '<div class="notice notice-info bc-admin-notice" style="background:#fffbeb;border-left:4px solid #f59e0b;padding:12px 20px;margin:10px auto;max-width:1200px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">';
            echo '<p style="margin:0;font-size:14px;color:#92400e;"><strong>Biharcabs Notice:</strong> Your Home page is created! To complete setup, <a href="' . esc_url(admin_url('themes.php?page=biharcabs-setup')) . '" style="color:#b45309;font-weight:bold;text-decoration:underline;">Click here to set it as Homepage</a> or <a href="' . esc_url(admin_url('post.php?post=' . $home_page->ID . '&action=elementor')) . '" style="color:#b45309;font-weight:bold;text-decoration:underline;">Edit with Elementor</a>.</p>';
            echo '</div>';
        }

        // Render the page content via Elementor or standard content
        if (did_action('elementor/loaded') && \Elementor\Plugin::$instance->documents->get($home_page->ID)->is_built_with_elementor()) {
            echo \Elementor\Plugin::$instance->frontend->get_builder_content_for_display($home_page->ID, true);
        } else {
            global $post;
            $post = $home_page;
            setup_postdata($post);
            the_content();
            wp_reset_postdata();
        }
    } else {
        // 3. Fresh install preview fallback
        if (current_user_can('edit_theme_options')) {
            echo '<div class="notice notice-warning bc-admin-notice" style="background:#eff6ff;border-left:4px solid #3b82f6;padding:12px 20px;margin:10px auto;max-width:1200px;border-radius:4px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">';
            echo '<p style="margin:0;font-size:14px;color:#1e40af;"><strong>Welcome to BiharCabs!</strong> You are currently viewing the static demo preview. <a href="' . esc_url(admin_url('themes.php?page=biharcabs-setup')) . '" style="color:#2563eb;font-weight:bold;text-decoration:underline;">Click here to Import All 7 Editable Demo Pages with Elementor</a>.</p>';
            echo '</div>';
        }
        echo bc_fragment('index');
    }
}

echo '</main>';
get_footer();
