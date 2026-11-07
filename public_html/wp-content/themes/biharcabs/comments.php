<?php
if(!defined('ABSPATH') || post_password_required())return;
if(have_comments()){echo '<section class="bc-comments"><h2>'.esc_html__('Comments','biharcabs').'</h2><ol>';wp_list_comments(array('style'=>'ol','short_ping'=>true));echo '</ol>';the_comments_pagination();echo '</section>';}
comment_form();
