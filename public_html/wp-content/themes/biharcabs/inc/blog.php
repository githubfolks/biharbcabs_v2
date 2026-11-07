<?php
if(!defined('ABSPATH'))exit;
function bc_reading_minutes($post_id=0){$text=wp_strip_all_tags(strip_shortcodes(get_post_field('post_content',$post_id?:get_the_ID())));return max(1,(int)ceil(str_word_count($text)/200));}
function bc_post_card($more='Read story'){
 $categories=get_the_category();
 ?>
 <article <?php post_class('bc-journal-card'); ?>>
 <a class="bc-journal-image" href="<?php the_permalink(); ?>" aria-label="<?php echo esc_attr(get_the_title()); ?>">
 <?php if(has_post_thumbnail()):the_post_thumbnail('large',array('loading'=>'lazy'));else: ?><span class="bc-journal-placeholder"><i class="fas fa-route" aria-hidden="true"></i><span><?php esc_html_e('Explore Bihar','biharcabs'); ?></span></span><?php endif; ?>
 </a><div class="bc-journal-copy">
 <div class="bc-journal-meta"><?php if($categories): ?><a class="bc-category-pill" href="<?php echo esc_url(get_category_link($categories[0])); ?>"><?php echo esc_html($categories[0]->name); ?></a><?php endif; ?><span><?php echo esc_html(sprintf(__('%s min read','biharcabs'),bc_reading_minutes())); ?></span></div>
 <h2><a href="<?php the_permalink(); ?>"><?php the_title(); ?></a></h2><p><?php echo esc_html(wp_trim_words(wp_strip_all_tags(get_the_excerpt()),24)); ?></p>
 <div class="bc-card-bottom"><time datetime="<?php echo esc_attr(get_the_date(DATE_W3C)); ?>"><?php echo esc_html(get_the_date()); ?></time><a href="<?php the_permalink(); ?>"><?php echo esc_html($more); ?> <span aria-hidden="true">↗</span></a></div>
 </div></article>
 <?php
}
function bc_journal_header($title='Travel stories & useful guides',$intro='Ideas for your next journey, local insights and practical travel advice.',$eyebrow='THE BIHARCABS JOURNAL'){
 ?>
 <div class="bc-journal-hero"><div class="bc-journal-hero-inner"><span class="bc-journal-eyebrow"><?php echo esc_html($eyebrow); ?></span><h1><?php echo esc_html($title); ?></h1><?php if($intro): ?><div class="bc-journal-intro"><?php echo wp_kses_post(wpautop($intro)); ?></div><?php endif; ?><form role="search" method="get" class="bc-journal-search" action="<?php echo esc_url(home_url('/')); ?>"><input aria-label="<?php esc_attr_e('Search articles','biharcabs'); ?>" type="search" name="s" value="<?php echo esc_attr(get_search_query()); ?>" placeholder="<?php esc_attr_e('Where will your next journey take you?','biharcabs'); ?>"><input type="hidden" name="post_type" value="post"><button type="submit" aria-label="<?php esc_attr_e('Search','biharcabs'); ?>"><i class="fas fa-search" aria-hidden="true"></i></button></form></div><span class="bc-journal-hero-mark" aria-hidden="true"><i class="fas fa-route"></i></span></div>
 <?php
}
function bc_blog_category_nav(){
 $categories=get_categories(array('hide_empty'=>true,'number'=>12));if(!$categories)return;
 echo '<nav class="bc-journal-categories" aria-label="'.esc_attr__('Browse categories','biharcabs').'"><a href="'.esc_url(bc_page_url('blog')).'">'.esc_html__('All stories','biharcabs').'</a>';
 foreach($categories as $category)echo '<a'.(is_category($category->term_id)?' aria-current="page"':'').' href="'.esc_url(get_category_link($category)).'">'.esc_html($category->name).'</a>';echo '</nav>';
}
function bc_article_part($part,$settings=array()){
 $copy=function($key,$fallback)use($settings){return is_string($settings[$key]??null)?$settings[$key]:$fallback;};
 $article=get_queried_object();if(!($article instanceof WP_Post)||$article->post_type!=='post'){$posts=get_posts(array('numberposts'=>1,'post_status'=>'publish'));$article=$posts[0]??null;}
 if(!$article){echo '<p class="bc-journal-empty">'.esc_html__('Publish a post to preview this article template.','biharcabs').'</p>';return;}
 global $post;$previous=$post;$post=$article;setup_postdata($post);
 if($part==='header'){
  echo '<header class="bc-article-header"><nav class="bc-article-breadcrumb" aria-label="'.esc_attr__('Breadcrumb','biharcabs').'"><a href="'.esc_url(home_url('/')).'">'.esc_html__('Home','biharcabs').'</a><span aria-hidden="true"> / </span><a href="'.esc_url(bc_page_url('blog')).'">'.esc_html__('Journal','biharcabs').'</a></nav>';
  echo '<div class="bc-article-categories">';the_category(' ');echo '</div><h1>'.esc_html(get_the_title()).'</h1><div class="bc-article-byline"><br><time datetime="'.esc_attr(get_the_date(DATE_W3C)).'">'.esc_html(get_the_date()).'</time></span><span class="bc-reading-time">'.esc_html(sprintf(__('%s min read','biharcabs'),bc_reading_minutes())).'</span></div></header>';
  if(has_post_thumbnail())echo '<div class="bc-article-cover">'.get_the_post_thumbnail($article,'full').'</div>';
 }elseif($part==='content'){
  echo '<div class="bc-article-layout"><div class="bc-article-main"><div class="bc-article-body">';the_content();wp_link_pages();echo '</div><div class="bc-article-tags">';the_tags('','','');echo '</div>';
  $url=get_permalink();echo '<div class="bc-article-share"><strong>'.esc_html__('Share this story','biharcabs').'</strong><a target="_blank" rel="noopener noreferrer" href="'.esc_url('https://wa.me/?text='.rawurlencode(get_the_title().' '.$url)).'">WhatsApp</a><a href="'.esc_url('mailto:?subject='.rawurlencode(get_the_title()).'&body='.rawurlencode($url)).'">Email</a></div>';
  the_post_navigation(array('prev_text'=>'<small>'.esc_html__('Previous story','biharcabs').'</small>%title','next_text'=>'<small>'.esc_html__('Next story','biharcabs').'</small>%title'));if(comments_open()||get_comments_number())comments_template();
  echo '</div><aside class="bc-article-aside"><div class="bc-trip-card"><span class="bc-journal-eyebrow">'.esc_html__('YOUR NEXT JOURNEY','biharcabs').'</span><h2>'.esc_html($copy('sidebar_title',__('Ready to explore Bihar?','biharcabs'))).'</h2><p>'.esc_html($copy('sidebar_text',__('Plan your trip with a local team. Tell us where you want to go.','biharcabs'))).'</p><a class="theme-btn" href="'.esc_url(bc_page_url('contact')).'">'.esc_html($copy('sidebar_button',__('Plan my ride','biharcabs'))).' <span aria-hidden="true">↗</span></a></div><div class="bc-sidebar-categories"><h3>'.esc_html__('Explore topics','biharcabs').'</h3>';bc_blog_category_nav();echo '</div></aside></div>';
 }elseif($part==='related'){
  $q=new WP_Query(array('post_type'=>'post','post_status'=>'publish','posts_per_page'=>3,'post__not_in'=>array($article->ID),'ignore_sticky_posts'=>true,'no_found_rows'=>true));
  if($q->have_posts()){echo '<section class="bc-related-stories"><span class="bc-journal-eyebrow">'.esc_html__('KEEP EXPLORING','biharcabs').'</span><h2>'.esc_html($copy('related_title',__('More from the journal','biharcabs'))).'</h2><div class="bc-journal-grid">';while($q->have_posts()){$q->the_post();bc_post_card();}echo '</div></section>';}
 }
 $post=$previous;if($post)setup_postdata($post);
}
function bc_render_blog_template($kind){
 if(!did_action('elementor/loaded'))return false;$ids=get_option('bc_blog_templates',array());$template_id=absint($ids[$kind]??0);
 if(!$template_id||get_post_status($template_id)!=='publish')return false;
 $html=\Elementor\Plugin::$instance->frontend->get_builder_content_for_display($template_id,true);if(!$html)return false;echo $html;return true;
}
function bc_install_blog_templates(){
 if(!current_user_can('manage_options')||!current_user_can('edit_posts')||!did_action('elementor/loaded'))return;
 $ids=get_option('bc_blog_templates',array());
 foreach(array('archive'=>'Biharcabs Blog Archive','single'=>'Biharcabs Single Post') as $kind=>$title){
  if(!empty($ids[$kind])&&get_post($ids[$kind]))continue;
  $template_id=wp_insert_post(array('post_type'=>'elementor_library','post_status'=>'publish','post_title'=>$title),true);if(is_wp_error($template_id)||!$template_id)continue;
  $children=array();if($kind==='archive'){$children[]=array('id'=>'bcarch1','elType'=>'widget','widgetType'=>'biharcabs-journal-header','settings'=>array('context'=>'archive'),'elements'=>array());$children[]=array('id'=>'bcarch2','elType'=>'widget','widgetType'=>'biharcabs-posts','settings'=>array('query_source'=>'archive','layout'=>bc_setting('blog_style')),'elements'=>array());}
  else foreach(array('header','content','related') as $i=>$part)$children[]=array('id'=>'bcpost'.$i,'elType'=>'widget','widgetType'=>'biharcabs-article','settings'=>array('part'=>$part),'elements'=>array());
  $data=array(array('id'=>'bc'.($kind==='single'?'single':'archiv'),'elType'=>'container','settings'=>array('content_width'=>'full','css_classes'=>'bc-journal-template','flex_direction'=>'column','flex_gap'=>array('unit'=>'px','size'=>0,'row'=>'0','column'=>'0')),'elements'=>$children));
  update_post_meta($template_id,'_elementor_data',wp_slash(wp_json_encode($data)));update_post_meta($template_id,'_elementor_edit_mode','builder');update_post_meta($template_id,'_elementor_template_type','container');$ids[$kind]=$template_id;
 }
 update_option('bc_blog_templates',$ids,false);
}
