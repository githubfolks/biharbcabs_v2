<?php
/**
 * Versioned, idempotent content migrations.
 *
 * Home and Contact content lives in Elementor data in the database, so a theme deploy alone cannot
 * correct it. Each migration here runs once per site, recorded in the bc_content_version option.
 */
if (!defined('ABSPATH')) exit;

define('BC_CONTENT_VERSION', 1);

/** Version 1: the home page review card named another company ("Akshay Cabs Experience"). */
function bc_migrate_content_1() {
    global $wpdb;
    $pattern = '/Akshay(?:\\\\n|\s)+Cabs Experience/';
    $replacement = 'Passenger Experience';

    // Live pages only. Revisions stay as history, and update_post_meta() would redirect a revision's
    // value onto its parent, overwriting the live page with old content.
    $metas = $wpdb->get_results($wpdb->prepare(
        "SELECT m.post_id, m.meta_value FROM {$wpdb->postmeta} m
         INNER JOIN {$wpdb->posts} p ON p.ID = m.post_id
         WHERE m.meta_key = %s AND m.meta_value LIKE %s AND p.post_type = %s",
        '_elementor_data',
        '%Akshay%',
        'page'
    ));
    foreach ($metas as $meta) {
        $fixed = preg_replace($pattern, $replacement, $meta->meta_value);
        if ($fixed === null) return false;
        if ($fixed === $meta->meta_value) continue;
        $json = json_decode($fixed, true);
        if (!is_array($json)) return false;
        if (!update_post_meta((int) $meta->post_id, '_elementor_data', wp_slash($fixed))) return false;
        delete_post_meta((int) $meta->post_id, '_elementor_element_cache');
    }

    $posts = $wpdb->get_results($wpdb->prepare(
        "SELECT ID, post_content FROM {$wpdb->posts} WHERE post_type = %s AND post_content LIKE %s",
        'page',
        '%Akshay%'
    ));
    foreach ($posts as $post) {
        $fixed = preg_replace($pattern, $replacement, $post->post_content);
        if ($fixed === null) return false;
        if ($fixed === $post->post_content) continue;
        if ($wpdb->update($wpdb->posts, array('post_content' => $fixed), array('ID' => (int) $post->ID)) === false) return false;
        clean_post_cache((int) $post->ID);
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
