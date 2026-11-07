<?php
/**
 * Biharcabs Theme Functions and Definitions
 * Version: 1.1.4
 */
if (!defined('ABSPATH')) { exit; }

require_once __DIR__ . '/inc/settings.php';
require_once __DIR__ . '/inc/integrations.php';
require_once __DIR__ . '/inc/demo-import.php';
require_once __DIR__ . '/inc/native-elementor.php';
require_once __DIR__ . '/inc/blog.php';

/**
 * Theme Setup
 */
function bc_setup() {
    load_theme_textdomain('biharcabs', get_template_directory() . '/languages');

    foreach (array(
        'title-tag',
        'post-thumbnails',
        'automatic-feed-links',
        'responsive-embeds',
        'align-wide',
        'wp-block-styles',
        'editor-styles',
        'custom-spacing',
        'custom-line-height'
    ) as $feature) {
        add_theme_support($feature);
    }

    add_theme_support('html5', array(
        'search-form',
        'comment-form',
        'comment-list',
        'gallery',
        'caption',
        'style',
        'script',
        'navigation-widgets'
    ));

    add_theme_support('custom-logo', array(
        'height'      => 90,
        'width'       => 260,
        'flex-height' => true,
        'flex-width'  => true
    ));

    register_nav_menus(array(
        'primary' => __('Primary Menu', 'biharcabs'),
        'footer'  => __('Footer Menu', 'biharcabs')
    ));

    $GLOBALS['content_width'] = 1200;
}
add_action('after_setup_theme', 'bc_setup');

/**
 * Theme Activation: Auto-configure Elementor Flexbox Container experiment
 */
add_action('after_switch_theme', function() {
    // If Elementor is present, ensure Container experiment is active so layouts don't fail
    if (get_option('elementor_experiment-container') !== 'active') {
        update_option('elementor_experiment-container', 'active');
    }
});

function bc_asset($path) {
    return get_template_directory_uri() . '/assets/' . ltrim($path, '/');
}

/**
 * Enqueue Styles and Scripts
 */
function bc_assets() {
    $css = array('bootstrap.min', 'all-fontawesome.min', 'animate.min', 'style');
    $previous = array();
    foreach ($css as $name) {
        wp_enqueue_style('bc-' . $name, bc_asset('css/' . $name . '.css'), $previous, '1.1.4');
        $previous = array('bc-' . $name);
    }
    wp_enqueue_style('biharcabs', get_stylesheet_uri(), $previous, '1.1.4');

    $scripts = array('bootstrap.bundle.min', 'main');
    $deps = array();
    foreach ($scripts as $name) {
        wp_enqueue_script('bc-' . $name, bc_asset('js/' . $name . '.js'), $deps, '1.1.4', true);
        $deps[] = 'bc-' . $name;
    }
    wp_enqueue_script('biharcabs', bc_asset('js/biharcabs.js'), $deps, '1.1.4', true);

    $js_vars = array(
        'sticky'          => (bool) bc_setting('sticky'),
        'locationKey'     => bc_setting('location_key'),
        'locationEnabled' => (bool) bc_setting('location_enabled'),
        'ajaxUrl'         => admin_url('admin-ajax.php'),
        'contactNonce'    => wp_create_nonce('bc_contact'),
        'bookingNonce'    => wp_create_nonce('bc_booking'),
        'whatsapp'        => bc_setting('whatsapp'),
        'phone'           => bc_phone(bc_setting('phone')),
        'phoneLabel'      => bc_setting('phone_label')
    );
    wp_localize_script('bc-main', 'biharcabs', $js_vars);
    wp_localize_script('biharcabs', 'biharcabs', $js_vars);

    if (bc_setting('language')) {
        wp_enqueue_script('bc-translate', 'https://cdn.gtranslate.net/widgets/latest/dropdown.js', array(), null, true);
        wp_add_inline_script('bc-translate', 'window.gtranslateSettings = ' . wp_json_encode(array('default_language' => 'en', 'languages' => array('en', 'hi'), 'wrapper_selector' => '.gtranslate_wrapper')) . ';', 'before');
    }

    if (is_singular() && comments_open() && get_option('thread_comments')) {
        wp_enqueue_script('comment-reply');
    }
}
add_action('wp_enqueue_scripts', 'bc_assets');

/**
 * Helper to get clean permalink for standard pages
 */
function bc_page_url($slug) {
    if ($slug === 'index' || $slug === 'home') return home_url('/');
    if ($slug === 'blog' && get_option('page_for_posts')) return get_permalink((int) get_option('page_for_posts'));
    $page = get_page_by_path($slug, OBJECT, array('page'));
    if (!$page && in_array($slug, array_keys(bc_demo_pages()), true)) {
        $mapped = get_posts(array(
            'post_type'   => 'page',
            'post_status' => 'publish',
            'numberposts' => 1,
            'meta_key'    => '_bc_demo_page',
            'meta_value'  => $slug
        ));
        $page = $mapped ? $mapped[0] : null;
    }
    return $page ? get_permalink($page) : home_url('/' . $slug . '/');
}

/**
 * Render Demo Fragments with Dynamic Replacements
 */
function bc_fragment($name) {
    $allowed = array('header', 'footer', 'overlays', 'index', 'service', 'cities', 'about', 'contact', 'fares', '404');
    if (!in_array($name, $allowed, true)) return '';

    $file = get_template_directory() . '/demo/' . $name . '.html';
    if (!file_exists($file)) return '';
    $html = file_get_contents($file);

    $html = preg_replace_callback('~(?<![\w/])assets/([^\s"\'<>)]*(?: [^\s"\'<>)]*)?)~', function($m) {
        return esc_url(bc_asset($m[1]));
    }, $html);

    $html = preg_replace_callback('~href="(index|service|cities|about|contact|fares|blog)\.html(#[^"]*)?"~', function($m) {
        return 'href="' . esc_url(bc_page_url($m[1]) . ($m[2] ?? '')) . '"';
    }, $html);

    $phone = bc_phone(bc_setting('phone'));
    $wa = bc_digits(bc_setting('whatsapp'));
    $html = str_replace(
        array('tel:+917070992170', 'https://wa.me/917070992170', 'info@biharcabs.com', '070709 92170', '+91 7070992170'),
        array('tel:' . esc_attr($phone), 'https://wa.me/' . esc_attr($wa), esc_html(bc_setting('email')), esc_html(bc_setting('phone_label')), esc_html(bc_setting('phone_label'))),
        $html
    );

    $html = str_replace('Taxi Stand Rd, near Hanuman mandir pin code, Sarvoday Nagar, Purnia, Bihar 854301', esc_html(bc_setting('address')), $html);

    if (bc_setting('primary') !== '#facc15') {
        $html = str_ireplace('#facc15', sanitize_hex_color(bc_setting('primary')), $html);
    }
    if (bc_setting('secondary') !== '#111827') {
        $html = str_ireplace('#111827', sanitize_hex_color(bc_setting('secondary')), $html);
    }

    $logo = (int) get_theme_mod('custom_logo');
    if ($logo) {
        $logo_url = wp_get_attachment_image_url($logo, 'full');
        if ($logo_url) {
            $html = str_replace(
                array(
                    esc_url(bc_asset('img/img/logo_bihar cabs.png')),
                    bc_asset('img/img/logo_bihar cabs.png'),
                    esc_url(bc_asset('img/img/logo_bihar_cabs.png')),
                    bc_asset('img/img/logo_bihar_cabs.png'),
                    'assets/img/img/logo_bihar cabs.png',
                    'assets/img/img/logo_bihar_cabs.png'
                ),
                esc_url($logo_url),
                $html
            );
        }
    }

    if ($name === 'header') {
        $html = str_replace('nav-link active', 'nav-link', $html);
        $current = is_front_page() ? 'index' : get_post_field('post_name', get_queried_object_id());
        if (is_home() || is_single() || is_archive()) $current = 'blog';
        $html = str_replace('class="nav-link" href="' . esc_url(bc_page_url($current)) . '"', 'class="nav-link active" aria-current="page" href="' . esc_url(bc_page_url($current)) . '"', $html);
        
        if (has_nav_menu('primary')) {
            $menu = wp_nav_menu(array(
                'theme_location' => 'primary',
                'container'      => false,
                'items_wrap'     => '%3$s',
                'echo'           => false,
                'fallback_cb'    => false,
                'depth'          => 2
            ));
            $html = preg_replace_callback('~(<ul class="navbar-nav">)[\s\S]*?(<li class="nav-item d-none d-lg-flex)~', function($m) use ($menu) {
                return $m[1] . $menu . $m[2];
            }, $html, 1);
        }
        if (!bc_setting('topbar')) {
            $html = preg_replace('~<div class="header-top">[\s\S]*?(?=<div class="main-navigation">)~', '', $html, 1);
        }
    }

    if ($name === 'footer') {
        $html = preg_replace_callback('~The most trusted and reliable 24x7 cab service operating across Bihar,\s*managed locally with pride\.~', function() {
            return esc_html(bc_setting('footer_about'));
        }, $html);
        $html = str_replace('&copy; 2026 BiharCabs. All Rights Reserved.', esc_html(bc_setting('copyright')), $html);
        if (bc_setting('footer_logo')) {
            $html = str_replace(esc_url(bc_asset('img/img/logo.jpg')), esc_url(bc_setting('footer_logo')), $html);
        }
        if (has_nav_menu('footer')) {
            $menu = wp_nav_menu(array(
                'theme_location' => 'footer',
                'container'      => false,
                'items_wrap'     => '<ul class="bc-footer-menu">%3$s</ul>',
                'echo'           => false,
                'fallback_cb'    => false,
                'depth'          => 1
            ));
            $html = preg_replace_callback('~(<h4 class="text-white mb-4">Quick Links</h4>)[\s\S]*?(</div>)~', function($m) use ($menu) {
                return $m[1] . $menu . $m[2];
            }, $html, 1);
        }
    }

    $has_social = false;
    foreach (array('facebook', 'twitter', 'instagram', 'linkedin') as $network) {
        if (bc_setting($network)) {
            $has_social = true;
            $html = str_replace('href="#"><i class="fab fa-' . $network . '"', 'href="' . esc_url(bc_setting($network)) . '" rel="noopener noreferrer"><i class="fab fa-' . $network . '"', $html);
        } else {
            // No profile configured: drop the icon rather than render a dead link.
            $html = preg_replace('~\s*<a href="#"><i class="fab fa-' . $network . '"></i></a>~', '', $html);
        }
    }
    if (!$has_social) {
        $html = str_replace(array('<span>Follow Us: </span>', '<h4>Follow Us</h4>'), '', $html);
    }
    $html = str_replace(
        '<a href="#"><i class="fas fa-location-dot">',
        '<a href="' . esc_url('https://www.google.com/maps/search/?api=1&query=' . rawurlencode(bc_setting('address'))) . '" target="_blank" rel="noopener noreferrer"><i class="fas fa-location-dot">',
        $html
    );

    if (!bc_setting('language')) {
        $html = preg_replace('~<div class="gtranslate_wrapper[^"<>]*"></div>~', '', $html);
    }

    if ($name === 'contact') {
        $html = preg_replace('~(<form\b[^>]*id="lf-form"[^>]*>)~', '$1<div class="bc-honeypot" aria-hidden="true"><label>Leave blank<input name="website" tabindex="-1" autocomplete="off"></label></div><div role="status" class="bc-contact-status" aria-live="polite"></div>', $html);
    }

    return $html;
}

/**
 * Shortcode [biharcabs_demo page="index"]
 */
function bc_demo_shortcode($atts) {
    $atts = shortcode_atts(array('page' => 'index'), $atts, 'biharcabs_demo');
    return bc_fragment(sanitize_key($atts['page']));
}
add_shortcode('biharcabs_demo', 'bc_demo_shortcode');

add_filter('nav_menu_css_class', function($classes, $item, $args) {
    if (($args->theme_location ?? '') === 'primary') {
        $classes[] = 'nav-item';
        if (in_array('menu-item-has-children', $classes, true)) $classes[] = 'dropdown';
    }
    return $classes;
}, 10, 3);

add_filter('nav_menu_link_attributes', function($atts, $item, $args) {
    if (($args->theme_location ?? '') === 'primary') {
        $atts['class'] = 'nav-link' . (in_array('current-menu-item', $item->classes, true) ? ' active' : '');
    }
    return $atts;
}, 10, 3);

/**
 * Elementor Compatibility & Widgets
 */
add_action('elementor/theme/register_locations', function($manager) {
    $manager->register_all_core_location();
});

add_action('elementor/widgets/register', function($manager) {
    require_once __DIR__ . '/inc/elementor.php';
    $manager->register(new Biharcabs_Demo_Widget());

    require_once __DIR__ . '/inc/native-widgets.php';
    $manager->register(new Biharcabs_Form_Widget());
    $manager->register(new Biharcabs_FAQ_Widget());
    $manager->register(new Biharcabs_Posts_Widget());

    require_once __DIR__ . '/inc/blog-widgets.php';
    $manager->register(new Biharcabs_Journal_Header_Widget());
    $manager->register(new Biharcabs_Article_Widget());
});


// Add custom script fields to pages and posts.
add_action('add_meta_boxes', function () {
    if (!current_user_can('manage_options') ||
        !current_user_can('unfiltered_html')) {
        return;
    }

    add_meta_box(
        'tepals_custom_scripts',
        'Custom Header & Footer Scripts',
        'tepals_render_script_fields',
        array('post', 'page'),
        'normal',
        'default'
    );
});

function tepals_render_script_fields($post) {
    wp_nonce_field('tepals_save_scripts', 'tepals_scripts_nonce');

    $fields = array(
        '_tepals_header_script' => 'Header Script — inside <head>',
        '_tepals_footer_script' => 'Footer Script — near the end of <body>',
    );

    echo '<p>Paste complete HTML, including &lt;script&gt; tags. PHP is not supported.</p>';

    foreach ($fields as $key => $label) {
        echo '<p><label for="' . esc_attr($key) . '"><strong>'
            . esc_html($label) . '</strong></label></p>';

        echo '<textarea id="' . esc_attr($key) . '" name="'
            . esc_attr($key)
            . '" rows="8" style="width:100%;font-family:monospace;">'
            . esc_textarea(get_post_meta($post->ID, $key, true))
            . '</textarea>';
    }
}

// Save scripts when the page or post is updated.
add_action('save_post', function ($post_id) {
    if (
        (defined('DOING_AUTOSAVE') && DOING_AUTOSAVE) ||
        wp_is_post_revision($post_id) ||
        wp_is_post_autosave($post_id)
    ) {
        return;
    }

    if (!in_array(get_post_type($post_id), array('post', 'page'), true)) {
        return;
    }

    if (
        !current_user_can('edit_post', $post_id) ||
        !current_user_can('manage_options') ||
        !current_user_can('unfiltered_html')
    ) {
        return;
    }

    if (
        !isset($_POST['tepals_scripts_nonce']) ||
        !is_string($_POST['tepals_scripts_nonce']) ||
        !wp_verify_nonce(
            wp_unslash($_POST['tepals_scripts_nonce']),
            'tepals_save_scripts'
        )
    ) {
        return;
    }

    foreach (array('_tepals_header_script', '_tepals_footer_script') as $key) {
        if (!isset($_POST[$key]) || !is_string($_POST[$key])) {
            continue;
        }

        $script = wp_unslash($_POST[$key]);

        if (trim($script) === '') {
            delete_post_meta($post_id, $key);
        } else {
            // Preserve script tags and literal backslashes.
            update_post_meta($post_id, $key, wp_slash($script));
        }
    }
});

// Output scripts only on the matching page or post.
function tepals_output_custom_script($meta_key) {
    if (!is_singular(array('post', 'page')) || is_feed()) {
        return;
    }

    $script = get_post_meta(get_queried_object_id(), $meta_key, true);

    if (is_string($script) && trim($script) !== '') {
        // Intentionally output trusted administrator-provided HTML.
        echo "\n" . $script . "\n";
    }
}

add_action('wp_head', function () {
    tepals_output_custom_script('_tepals_header_script');
}, 99);

add_action('wp_footer', function () {
    tepals_output_custom_script('_tepals_footer_script');
}, 99);
