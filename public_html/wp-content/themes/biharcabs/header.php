<?php if (!defined('ABSPATH')) exit; ?>
<!DOCTYPE html>
<html <?php language_attributes(); ?>>
<head>
<meta charset="<?php bloginfo('charset'); ?>">
<meta name="viewport" content="width=device-width, initial-scale=1">
<?php wp_head(); ?>
</head>
<body <?php body_class(); ?>>
<?php wp_body_open(); ?>
<a class="skip-link screen-reader-text" href="#main-content"><?php esc_html_e('Skip to content', 'biharcabs'); ?></a>
<?php
if (function_exists('hfe_render_header') && function_exists('hfe_header_enabled') && hfe_header_enabled()) {
    hfe_render_header();
} elseif (function_exists('elementor_theme_do_location') && elementor_theme_do_location('header')) {
    preg_match_all('~<style\b[^>]*>[\s\S]*?</style>~', bc_fragment('header'), $styles);
    if (!empty($styles[0])) echo implode("\n", $styles[0]);
} else {
    echo bc_fragment('header');
}
?>
