<?php
/**
 * Versioned, idempotent content migrations.
 *
 * Home and Contact content lives in Elementor data in the database, so a theme deploy alone cannot
 * correct it. Each migration here runs once per site, recorded in the bc_content_version option.
 */
if (!defined('ABSPATH')) exit;

define('BC_CONTENT_VERSION', 2);

/**
 * Apply regex replacements to live pages' Elementor data and content.
 *
 * Live pages only. Revisions stay as history, and update_post_meta() would redirect a revision's
 * value onto its parent, overwriting the live page with old content.
 *
 * @param array  $replacements Pattern => replacement.
 * @param string $needle       Plain text every affected page contains, to narrow the query.
 */
function bc_replace_in_live_pages($replacements, $needle) {
    global $wpdb;
    $patterns = array_keys($replacements);
    $values   = array_values($replacements);
    $like     = '%' . $wpdb->esc_like($needle) . '%';

    $metas = $wpdb->get_results($wpdb->prepare(
        "SELECT m.post_id, m.meta_value FROM {$wpdb->postmeta} m
         INNER JOIN {$wpdb->posts} p ON p.ID = m.post_id
         WHERE m.meta_key = %s AND m.meta_value LIKE %s AND p.post_type = %s",
        '_elementor_data',
        $like,
        'page'
    ));
    foreach ($metas as $meta) {
        $fixed = preg_replace($patterns, $values, $meta->meta_value);
        if ($fixed === null) return false;
        if ($fixed === $meta->meta_value) continue;
        if (!is_array(json_decode($fixed, true))) return false;
        if (!update_post_meta((int) $meta->post_id, '_elementor_data', wp_slash($fixed))) return false;
        delete_post_meta((int) $meta->post_id, '_elementor_element_cache');
    }

    $posts = $wpdb->get_results($wpdb->prepare(
        "SELECT ID, post_content FROM {$wpdb->posts} WHERE post_type = %s AND post_content LIKE %s",
        'page',
        $like
    ));
    foreach ($posts as $post) {
        $fixed = preg_replace($patterns, $values, $post->post_content);
        if ($fixed === null) return false;
        if ($fixed === $post->post_content) continue;
        if ($wpdb->update($wpdb->posts, array('post_content' => $fixed), array('ID' => (int) $post->ID)) === false) return false;
        clean_post_cache((int) $post->ID);
    }
    return true;
}

/** Version 1: the home page review card named another company ("Akshay Cabs Experience"). */
function bc_migrate_content_1() {
    return bc_replace_in_live_pages(array('/Akshay(?:\\\\n|\s)+Cabs Experience/' => 'Passenger Experience'), 'Akshay');
}

/** Version 2: one response-time promise of 30 minutes, replacing 2 minutes, "instantly" and 2-4 hours. */
function bc_migrate_content_2() {
    $gap = '(?:\\\\n|\s)+';
    $steps = array(
        'confirm in 2 minutes'  => array('/confirm in 2 minutes/' => 'confirm within 30 minutes'),
        'less than 2 minutes'   => array('/Driver confirmation' . $gap . 'takes less than 2 minutes/' => 'We confirm your booking within 30 minutes'),
        'respond instantly'     => array('/respond instantly/' => 'respond within 30 minutes'),
        'within 2-4 hours'      => array('/within 2-4 hours/' => 'within 30 minutes'),
    );
    foreach ($steps as $needle => $replacements) {
        if (!bc_replace_in_live_pages($replacements, $needle)) return false;
    }
    return true;
}

add_action('init', function () {
    $current = (int) get_option('bc_content_version', 0);
    while ($current < BC_CONTENT_VERSION) {
        $next = $current + 1;
        $migrate = 'bc_migrate_content_' . $next;
        if (!$migrate()) {
            error_log('Biharcabs content migration ' . $next . ' failed; it will retry on the next request.');
            return;
        }
        update_option('bc_content_version', $next, true);
        $current = $next;
    }
}, 20);
