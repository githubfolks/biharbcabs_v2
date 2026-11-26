<?php
/**
 * Production / Staging wp-config.php template for BiharCabs behind Nginx TLS reverse proxy.
 *
 * Setup on Oracle server:
 *   1. Copy to public_html/wp-config.php
 *   2. Replace the AUTH_KEY..WP_CACHE_KEY_SALT block with freshly generated keys from:
 *        curl -s https://api.wordpress.org/secret-key/1.1/salt/
 *   3. Ensure public_html/wp-config.php is chmod 640 and NEVER committed to git.
 */

define( 'WP_CACHE', false );

// Reverse-proxy HTTPS detection (Nginx terminates TLS and forwards X-Forwarded-Proto: https)
if ( isset( $_SERVER['HTTP_X_FORWARDED_PROTO'] ) && strpos( $_SERVER['HTTP_X_FORWARDED_PROTO'], 'https' ) !== false ) {
	$_SERVER['HTTPS'] = 'on';
}

// Database settings — injected via Docker environment from root .env
define( 'DB_NAME', getenv( 'WORDPRESS_DB_NAME' ) );
define( 'DB_USER', getenv( 'WORDPRESS_DB_USER' ) );
define( 'DB_PASSWORD', getenv( 'WORDPRESS_DB_PASSWORD' ) );
define( 'DB_HOST', getenv( 'WORDPRESS_DB_HOST' ) );
define( 'DB_CHARSET', 'utf8mb4' );
define( 'DB_COLLATE', '' );

// Authentication unique keys and salts — REPLACE ALL VALUES ON THE SERVER!
define( 'AUTH_KEY',          'REPLACE_WITH_FRESH_SALT' );
define( 'SECURE_AUTH_KEY',   'REPLACE_WITH_FRESH_SALT' );
define( 'LOGGED_IN_KEY',     'REPLACE_WITH_FRESH_SALT' );
define( 'NONCE_KEY',         'REPLACE_WITH_FRESH_SALT' );
define( 'AUTH_SALT',         'REPLACE_WITH_FRESH_SALT' );
define( 'SECURE_AUTH_SALT',  'REPLACE_WITH_FRESH_SALT' );
define( 'LOGGED_IN_SALT',    'REPLACE_WITH_FRESH_SALT' );
define( 'NONCE_SALT',        'REPLACE_WITH_FRESH_SALT' );
define( 'WP_CACHE_KEY_SALT', 'REPLACE_WITH_FRESH_SALT' );

$table_prefix = 'wp_';

if ( ! defined( 'WP_DEBUG' ) ) {
	define( 'WP_DEBUG', false );
}

define( 'FS_METHOD', 'direct' );
define( 'DISALLOW_FILE_EDIT', true );
define( 'WP_AUTO_UPDATE_CORE', false );
define( 'AUTOMATIC_UPDATER_DISABLED', true );
// WP-Cron is triggered explicitly by host cron / WP-CLI rather than on user page loads
define( 'DISABLE_WP_CRON', true );

if ( getenv( 'WP_HOME' ) ) {
	define( 'WP_HOME', getenv( 'WP_HOME' ) );
	define( 'WP_SITEURL', getenv( 'WP_SITEURL' ) );
}
if ( getenv( 'WP_ENVIRONMENT_TYPE' ) ) {
	define( 'WP_ENVIRONMENT_TYPE', getenv( 'WP_ENVIRONMENT_TYPE' ) );
}

if ( ! defined( 'ABSPATH' ) ) {
	define( 'ABSPATH', __DIR__ . '/' );
}

require_once ABSPATH . 'wp-settings.php';
