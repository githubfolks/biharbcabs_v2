<?php
if(!defined('ABSPATH'))exit;
get_header(); ?>
<main id="main-content" class="bc-journal-page"><div class="container">
<?php if(!function_exists('elementor_theme_do_location')||!elementor_theme_do_location('single')):if(!bc_render_blog_template('single')){bc_article_part('header');bc_article_part('content');bc_article_part('related');}endif; ?>
</div></main><?php get_footer(); ?>
