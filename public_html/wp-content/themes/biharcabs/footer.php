<?php
if (!defined('ABSPATH')) exit;

if (function_exists('hfe_render_footer') && function_exists('hfe_footer_enabled') && hfe_footer_enabled()) {
    hfe_render_footer();
} elseif (function_exists('elementor_theme_do_location') && elementor_theme_do_location('footer')) {
    // Rendered by Elementor Pro
} else {
    echo bc_fragment('footer');
}

echo bc_fragment('overlays');
wp_footer();
?>
</body>
</html>
