<?php
/**
 * Plugin Name: BiharCabs Growth Engine
 * Description: Rate card and fare quotes for the BiharCabs website and CRM.
 * Version: 1.0.0
 * Requires PHP: 8.0
 * Author: BiharCabs
 */
if (!defined('ABSPATH')) exit;

require_once __DIR__ . '/includes/class-calculator.php';
require_once __DIR__ . '/includes/class-rate-card.php';
require_once __DIR__ . '/includes/class-rest.php';
require_once __DIR__ . '/includes/class-admin.php';

add_action('rest_api_init', array('BCGE_Rest', 'register'));

if (is_admin()) {
    BCGE_Admin::init();
}

/** Quote URL for the theme, or '' while estimates are switched off so the site shows no prices. */
function bcge_public_quote_url() {
    return empty(BCGE_Rate_Card::get()['public_enabled']) ? '' : rest_url('biharcabs/v1/quote');
}

/** CRM-backed plans URL, or '' while CRM API base URL is not configured. */
function bcge_public_plans_url() {
    $card = BCGE_Rate_Card::get();
    return empty($card['crm_api_base_url']) ? '' : rest_url('biharcabs/v1/plans');
}

/** CRM-backed direct booking URL, or '' while CRM API base URL is not configured. */
function bcge_public_book_url() {
    $card = BCGE_Rate_Card::get();
    return empty($card['crm_api_base_url']) ? '' : rest_url('biharcabs/v1/book');
}
