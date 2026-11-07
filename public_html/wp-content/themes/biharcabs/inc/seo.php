<?php
/**
 * Biharcabs SEO & Social Graph Integration
 * Automatically adds TaxiService Schema, Open Graph, Twitter Cards & Canonical tags.
 */
if (!defined('ABSPATH')) exit;

function bc_has_seo_plugin() {
    return defined('WPSEO_VERSION') 
        || defined('RANK_MATH_VERSION') 
        || defined('AIOSEO_VERSION') 
        || defined('SEOPRESS_VERSION')
        || function_exists('the_seo_framework');
}

/**
 * Output SEO Meta, Social Tags and JSON-LD Schema
 */
add_action('wp_head', function() {
    if (bc_has_seo_plugin()) return;

    $site_title = get_bloginfo('name');
    $site_desc  = bc_setting('seo_description');
    $current_url = home_url(add_query_arg(array(), $GLOBALS['wp']->request ?? ''));
    if (!empty($_SERVER['REQUEST_URI'])) {
        $current_url = home_url($_SERVER['REQUEST_URI']);
    }

    $title = '';
    $description = '';
    $image = bc_setting('footer_logo') ?: bc_asset('img/img/hero.webp');
    $custom_logo_id = get_theme_mod('custom_logo');
    if ($custom_logo_id) {
        $logo_src = wp_get_attachment_image_url($custom_logo_id, 'full');
        if ($logo_src) $image = $logo_src;
    }

    if (is_front_page()) {
        $title = $site_title . ' | Best Cab & Taxi Service in Patna, Bihar (24/7)';
        $description = $site_desc ?: 'Looking for the best cab service in Patna, Bihar? Book affordable and reliable taxi service in Patna for outstation, airport drop, and local rides with Bihar Cabs.';
    } elseif (is_singular('page')) {
        $page_id = get_queried_object_id();
        $slug = get_post_meta($page_id, '_bc_demo_page', true);
        $metadata_file = get_template_directory() . '/demo/metadata.json';
        if ($slug && file_exists($metadata_file)) {
            $metadata = json_decode(file_get_contents($metadata_file), true);
            if (isset($metadata[$slug])) {
                $title = $metadata[$slug]['title'] ?? get_the_title();
                $description = $metadata[$slug]['description'] ?? '';
            }
        }
        if (!$title) $title = get_the_title() . ' - ' . $site_title;
        if (!$description) $description = wp_trim_words(wp_strip_all_tags(strip_shortcodes(get_post_field('post_content', $page_id))), 28, '...');
        if (has_post_thumbnail($page_id)) {
            $image = get_the_post_thumbnail_url($page_id, 'large');
        }
    } elseif (is_singular('post')) {
        $title = get_the_title() . ' - ' . $site_title;
        $description = wp_trim_words(wp_strip_all_tags(strip_shortcodes(get_the_excerpt())), 28, '...');
        if (has_post_thumbnail()) {
            $image = get_the_post_thumbnail_url(get_the_ID(), 'large');
        }
    } else {
        $title = wp_get_document_title();
        $description = $site_desc;
    }

    // Meta Description & Robots
    echo "\n<!-- Biharcabs SEO & Social Meta -->\n";
    if ($description) {
        echo '<meta name="description" content="' . esc_attr($description) . '">' . "\n";
    }
    echo '<meta name="robots" content="index, follow, max-image-preview:large">' . "\n";
    echo '<link rel="canonical" href="' . esc_url($current_url) . '">' . "\n";

    // Open Graph Tags
    echo '<meta property="og:locale" content="' . esc_attr(get_locale()) . '">' . "\n";
    echo '<meta property="og:type" content="' . (is_single() ? 'article' : 'website') . '">' . "\n";
    echo '<meta property="og:title" content="' . esc_attr($title) . '">' . "\n";
    if ($description) echo '<meta property="og:description" content="' . esc_attr($description) . '">' . "\n";
    echo '<meta property="og:url" content="' . esc_url($current_url) . '">' . "\n";
    echo '<meta property="og:site_name" content="' . esc_attr($site_title) . '">' . "\n";
    if ($image) echo '<meta property="og:image" content="' . esc_url($image) . '">' . "\n";

    // Twitter Card Tags
    echo '<meta name="twitter:card" content="summary_large_image">' . "\n";
    echo '<meta name="twitter:title" content="' . esc_attr($title) . '">' . "\n";
    if ($description) echo '<meta name="twitter:description" content="' . esc_attr($description) . '">' . "\n";
    if ($image) echo '<meta name="twitter:image" content="' . esc_url($image) . '">' . "\n";

    // JSON-LD Structured Data for TaxiService & LocalBusiness
    $phone = bc_setting('phone');
    $email = bc_setting('email');
    $address = bc_setting('address');

    $schema = array(
        '@context' => 'https://schema.org',
        '@graph'   => array(
            array(
                '@type'            => array('TaxiService', 'LocalBusiness'),
                '@id'              => home_url('/#taxiservice'),
                'name'             => $site_title ?: 'Bihar Cabs',
                'url'              => home_url('/'),
                'telephone'        => $phone ?: '+917070992170',
                'email'            => $email ?: 'info@biharcabs.com',
                'priceRange'       => '₹₹',
                'image'            => $image,
                'logo'             => $image,
                'description'      => $description,
                'openingHours'     => 'Mo-Su 00:00-23:59',
                'address'          => array(
                    '@type'           => 'PostalAddress',
                    'streetAddress'   => $address ?: 'Taxi Stand Rd, near Hanuman mandir, Sarvoday Nagar',
                    'addressLocality' => 'Purnia',
                    'addressRegion'   => 'Bihar',
                    'postalCode'      => '854301',
                    'addressCountry'  => 'IN'
                ),
                'areaServed'       => array(
                    array('@type' => 'City', 'name' => 'Patna'),
                    array('@type' => 'City', 'name' => 'Purnia'),
                    array('@type' => 'City', 'name' => 'Gaya'),
                    array('@type' => 'City', 'name' => 'Muzaffarpur'),
                    array('@type' => 'City', 'name' => 'Bhagalpur'),
                    array('@type' => 'City', 'name' => 'Darbhanga'),
                    array('@type' => 'State', 'name' => 'Bihar')
                ),
                'availableChannel' => array(
                    '@type'          => 'ServiceChannel',
                    'serviceUrl'     => home_url('/'),
                    'servicePhone'   => array(
                        '@type'     => 'ContactPoint',
                        'telephone' => $phone ?: '+917070992170',
                        'contactType' => 'customer service',
                        'availableLanguage' => array('Hindi', 'English')
                    )
                )
            ),
            array(
                '@type'       => 'FAQPage',
                '@id'         => home_url('/#faq'),
                'mainEntity'  => array(
                    array(
                        '@type'          => 'Question',
                        'name'           => 'How can I book a cab with Bihar Cabs?',
                        'acceptedAnswer' => array(
                            '@type' => 'Answer',
                            'text'  => 'You can easily book a cab online through our website booking form, by calling us at ' . ($phone ?: '+91 7070992170') . ', or directly on WhatsApp 24/7.'
                        )
                    ),
                    array(
                        '@type'          => 'Question',
                        'name'           => 'Are cabs available for outstation and airport pickup across Bihar?',
                        'acceptedAnswer' => array(
                            '@type' => 'Answer',
                            'text'  => 'Yes, Bihar Cabs provides 24/7 one-way, round-trip outstation cabs and airport pickup & drop services across Patna, Gaya, Muzaffarpur, Bhagalpur, Darbhanga, and Purnia.'
                        )
                    ),
                    array(
                        '@type'          => 'Question',
                        'name'           => 'What types of cars are available for booking?',
                        'acceptedAnswer' => array(
                            '@type' => 'Answer',
                            'text'  => 'We offer clean, well-maintained Sedan (Dzire, Etios), SUV (Innova, Ertiga), and Tempo Travellers driven by experienced professional drivers.'
                        )
                    )
                )
            )
        )
    );

    // If singular post, append Breadcrumb Schema
    if (is_singular('post')) {
        $schema['@graph'][] = array(
            '@type' => 'BreadcrumbList',
            'itemListElement' => array(
                array(
                    '@type'    => 'ListItem',
                    'position' => 1,
                    'name'     => 'Home',
                    'item'     => home_url('/')
                ),
                array(
                    '@type'    => 'ListItem',
                    'position' => 2,
                    'name'     => 'Journal',
                    'item'     => bc_page_url('blog')
                ),
                array(
                    '@type'    => 'ListItem',
                    'position' => 3,
                    'name'     => get_the_title(),
                    'item'     => get_permalink()
                )
            )
        );
    }

    echo '<script type="application/ld+json">' . wp_json_encode($schema, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE) . '</script>' . "\n";
    echo "<!-- /Biharcabs SEO -->\n";
}, 5);

/**
 * Filter Document Title for SEO
 */
add_filter('document_title_parts', function($parts) {
    if (bc_has_seo_plugin()) return $parts;
    
    $slug = is_front_page() ? 'index' : get_post_meta(get_queried_object_id(), '_bc_demo_page', true);
    $data_file = get_template_directory() . '/demo/metadata.json';
    if ($slug && file_exists($data_file)) {
        $data = json_decode(file_get_contents($data_file), true);
        if (isset($data[$slug]['title'])) {
            $parts['title'] = $data[$slug]['title'];
            unset($parts['site'], $parts['tagline']);
        }
    }
    return $parts;
});
