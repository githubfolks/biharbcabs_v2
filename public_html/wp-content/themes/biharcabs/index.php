<?php
if(!defined('ABSPATH'))exit;
get_header(); ?>
<main id="main-content" class="main bc-journal-page"><div class="container">
<?php if(!function_exists('elementor_theme_do_location')||!elementor_theme_do_location('archive')):if(!bc_render_blog_template('archive')):
$title=is_search()?sprintf(__('Search results for: %s','biharcabs'),get_search_query()):(is_archive()?wp_strip_all_tags(get_the_archive_title()):__('Travel stories & useful guides','biharcabs'));
bc_journal_header($title,is_archive()?get_the_archive_description():__('Ideas for your next journey, local insights and practical travel advice.','biharcabs'));bc_blog_category_nav(); ?>
<div class="bc-journal-<?php echo esc_attr(bc_setting('blog_style')); ?>">
<?php if(have_posts()):while(have_posts()):the_post();bc_post_card();endwhile;else: ?><p class="bc-journal-empty"><?php esc_html_e('No stories found. Try another search or check back soon.','biharcabs'); ?></p><?php endif; ?>
</div><div class="bc-pagination"><?php the_posts_pagination(); ?></div><?php endif;endif; ?></div></main>
<?php get_footer(); ?>
