<?php
if (!defined('ABSPATH')) exit;
get_header();
echo '<main id="main-content" class="main">';
if (have_posts()) { while(have_posts()){the_post(); the_content(); if(comments_open()||get_comments_number())comments_template();} }
echo '</main>';
get_footer();
