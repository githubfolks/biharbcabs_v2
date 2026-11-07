<?php
if(!defined('ABSPATH'))exit;

function bc_native_catalog(){
    static $catalog;
    if($catalog===null && file_exists(get_template_directory().'/elementor/catalog.json')) {
        $catalog=json_decode(file_get_contents(get_template_directory().'/elementor/catalog.json'),true);
    }
    return $catalog ?: array('nodes'=>array(), 'forms'=>array());
}

function bc_native_resolve($value){
    if(is_array($value)){
        foreach($value as $key=>$item)$value[$key]=bc_native_resolve($item);
        return $value;
    }
    if(!is_string($value))return $value;
    $value=str_replace('{{BC_ASSETS}}',get_template_directory_uri().'/assets',$value);
    return preg_replace_callback('/\{\{BC_PAGE_([a-z]+)\}\}/',function($m){return bc_page_url($m[1]);},$value);
}

function bc_native_data($page){
    if(!in_array($page,array('index','service','cities','about','contact','fares','blog'),true))return array();
    if($page==='blog') {
        return array(array(
            'id'=>'bcb1091',
            'elType'=>'container',
            'settings'=>array(
                'content_width'=>'full',
                'css_classes'=>'bc-native-page bc-page-blog',
                'flex_direction'=>'column',
                'flex_gap'=>array('unit'=>'px','size'=>0,'row'=>'0','column'=>'0')
            ),
            'elements'=>array(
                array('id'=>'bcb1092','elType'=>'widget','widgetType'=>'biharcabs-journal-header','settings'=>array('context'=>'blog'),'elements'=>array()),
                array('id'=>'bcb1093','elType'=>'widget','widgetType'=>'biharcabs-posts','settings'=>array('layout'=>bc_setting('blog_style'),'count'=>9),'elements'=>array())
            )
        ));
    }
    $file = get_template_directory().'/elementor/'.$page.'.json';
    if (!file_exists($file)) return array();
    return bc_native_resolve(json_decode(file_get_contents($file),true));
}

add_action('elementor/element/after_section_end',function($element,$section){
    $names=array('heading'=>'section_title','text-editor'=>'section_editor','image'=>'section_image','button'=>'section_button','container'=>'section_layout_container');
    if(($names[$element->get_name()]??null)!==$section)return;
    $element->start_controls_section('bc_source_controls',array('label'=>'Biharcabs styling','tab'=>\Elementor\Controls_Manager::TAB_ADVANCED));
    $element->add_control('bc_source',array('type'=>\Elementor\Controls_Manager::HIDDEN,'default'=>''));
    $element->add_control('bc_original_design',array('label'=>'Keep original theme styling','type'=>\Elementor\Controls_Manager::SWITCHER,'default'=>'yes','description'=>'Turn off to freely style this element using Elementor typography and colors.'));
    if($element->get_name()==='image')$element->add_control('bc_image_alt',array('label'=>'Image description (alt text)','type'=>\Elementor\Controls_Manager::TEXT,'default'=>''));
    $element->end_controls_section();
},10,2);

add_filter('elementor/widget/render_content',function($content,$widget){
    $source=$widget->get_settings('bc_source');
    if(!is_string($source))return $content;
    $node=bc_native_catalog()['nodes'][$source]??null;
    if(!$node)return $content;

    $type=$widget->get_name();
    $tag=$type==='heading'?strtoupper($widget->get_settings('header_size')?:'h2'):($type==='image'?'IMG':($type==='button'?'A':null));
    if(!$tag)return $content;

    if(!class_exists('WP_HTML_Tag_Processor'))return $content;

    $p=new WP_HTML_Tag_Processor($content);
    if(!$p->next_tag($tag))return $content;
    if($type==='image'&&is_string($widget->get_settings('bc_image_alt')))$p->set_attribute('alt',$widget->get_settings('bc_image_alt'));
    if($widget->get_settings('bc_original_design')!==''){
        $p->add_class('bc-source-'.$source);
        if($type==='button'&&!preg_match('/\b(theme-btn|btn-primary-custom)\b/',$node['attributes']['class']??''))$p->add_class('bc-native-link');
        foreach(explode(' ',$node['attributes']['class']??'') as $class)if($class)$p->add_class(sanitize_html_class($class));
    }
    foreach($node['attributes'] as $name=>$value){
        if(in_array($name,array('id','title','data-bs-toggle','data-bs-target','aria-label'),true))$p->set_attribute($name,$value);
    }
    return $p->get_updated_html();
},10,2);

add_action('elementor/frontend/container/before_render',function($element){
    $source=$element->get_settings('bc_source');
    if(!is_string($source))return;
    if(isset(bc_native_catalog()['nodes'][$source])&&$element->get_settings('bc_original_design')!=='')$element->add_render_attribute('_wrapper','class','bc-source-'.$source);
});

add_action('wp_enqueue_scripts',function(){
    wp_enqueue_style('bc-blog',bc_asset('css/blog.css'),array('biharcabs'),'1.1.4');
    wp_add_inline_style('bc-blog',':root{--bc-primary:'.sanitize_hex_color(bc_setting('primary')).';--bc-secondary:'.sanitize_hex_color(bc_setting('secondary')).';}');
    wp_enqueue_style('bc-native',bc_asset('css/native-elementor.css'),array('biharcabs'),'1.1.4');
});

function bc_native_backup($id){
    $backup=array(
        'content'=>get_post_field('post_content',$id),
        'data'=>get_post_meta($id,'_elementor_data',true),
        'mode'=>get_post_meta($id,'_elementor_edit_mode',true),
        'template'=>get_post_meta($id,'_wp_page_template',true),
        'native'=>get_post_meta($id,'_bc_native_elementor',true),
        'posts_page'=>(int)get_option('page_for_posts'),
        'demo'=>get_post_meta($id,'_bc_demo_page',true),
        'blog'=>get_post_meta($id,'_bc_blog_template',true),
        'type'=>get_post_meta($id,'_elementor_template_type',true),
        'version'=>get_post_meta($id,'_elementor_version',true)
    );
    update_post_meta($id,'_bc_before_native',wp_slash($backup));
}

function bc_native_save($id,$page,$backup=true){
    $can_elementor = did_action('elementor/loaded') || class_exists('\Elementor\Plugin');
    if(!current_user_can('edit_post',$id) || !$can_elementor) {
        return new WP_Error('bc_native_access','Elementor must be active and this page editable.');
    }
    if($page==='blog'&&(int)get_option('page_for_posts')===$id&&!current_user_can('manage_options')) {
        return new WP_Error('bc_native_access','An administrator must convert the posts page.');
    }
    if($backup) bc_native_backup($id);

    // Auto-enable container experiment
    update_option('elementor_experiment-container', 'active');

    $data=bc_native_data($page);
    if(!$data) return new WP_Error('bc_native_page','Unknown demo page.');

    update_post_meta($id,'_elementor_data',wp_slash(wp_json_encode($data)));
    update_post_meta($id,'_elementor_edit_mode','builder');
    update_post_meta($id,'_elementor_template_type','wp-page');
    if(defined('ELEMENTOR_VERSION')) update_post_meta($id,'_elementor_version',ELEMENTOR_VERSION);
    update_post_meta($id,'_bc_native_elementor','1.1.4');
    update_post_meta($id,'_bc_demo_page',$page);

    if($page==='blog'){
        update_post_meta($id,'_bc_blog_template',1);
        if((int)get_option('page_for_posts')===$id&&current_user_can('manage_options'))update_option('page_for_posts',0);
    }
    if(class_exists('\Elementor\Core\Files\CSS\Post')){ 
        $css=new \Elementor\Core\Files\CSS\Post($id);
        $css->delete(); 
    }
    return true;
}

function bc_native_is_untouched_legacy($id,$page){
    if(get_post_meta($id,'_bc_native_elementor',true))return false;
    $data=get_post_meta($id,'_elementor_data',true);
    $data=is_string($data)?json_decode($data,true):$data;
    if(empty($data))return true;
    return false;
}

add_action('admin_post_bc_native_page',function(){
    if(!current_user_can('edit_theme_options')||!current_user_can('manage_options'))wp_die('Permission denied.','',array('response'=>403));
    if(($_SERVER['REQUEST_METHOD']??'')!=='POST')wp_die('POST required.','',array('response'=>405));
    foreach(array('page_id','page_key','native_action','_wpnonce') as $name){
        if(!isset($_POST[$name])||!is_string($_POST[$name]))wp_die('Invalid request.','',array('response'=>400));
    }
    $id=absint($_POST['page_id']);
    $page=sanitize_key(wp_unslash($_POST['page_key']));
    check_admin_referer('bc_native_page_'.$id);
    if(!current_user_can('edit_post',$id)||get_post_type($id)!=='page'||!isset(bc_demo_pages()[$page]))wp_die('Invalid page.','',array('response'=>403));

    if($_POST['native_action']==='restore'){
        $result=bc_native_restore($id);
        if(is_wp_error($result))wp_die(esc_html($result->get_error_message()));
    }elseif($_POST['native_action']==='convert'){
        $result=bc_native_save($id,$page,true);
        if(is_wp_error($result))wp_die(esc_html($result->get_error_message()));
    }else {
        wp_die('Invalid action.','',array('response'=>400));
    }
    wp_safe_redirect(admin_url('themes.php?page=biharcabs-setup'));
    exit;
});

function bc_native_action_form($id,$key,$action,$label){
    echo '<form method="post" action="'.esc_url(admin_url('admin-post.php')).'" style="display:inline;">';
    echo '<input type="hidden" name="action" value="bc_native_page">';
    echo '<input type="hidden" name="page_id" value="'.esc_attr($id).'">';
    echo '<input type="hidden" name="page_key" value="'.esc_attr($key).'">';
    echo '<input type="hidden" name="native_action" value="'.esc_attr($action).'">';
    wp_nonce_field('bc_native_page_'.$id);
    echo '<button class="button button-small" type="submit">'.esc_html($label).'</button></form>';
}

function bc_native_restore($id){
    if(!current_user_can('manage_options')||!current_user_can('edit_post',$id))return new WP_Error('bc_native_access','Permission denied.');
    $b=get_post_meta($id,'_bc_before_native',true);
    if(!is_array($b))return new WP_Error('bc_native_backup','No backup exists.');
    $saved=wp_update_post(array('ID'=>$id,'post_content'=>wp_slash($b['content'])),true);
    if(is_wp_error($saved))return $saved;
    foreach(array('_elementor_data'=>'data','_elementor_edit_mode'=>'mode','_wp_page_template'=>'template','_bc_native_elementor'=>'native','_bc_demo_page'=>'demo','_bc_blog_template'=>'blog','_elementor_template_type'=>'type','_elementor_version'=>'version') as $key=>$field){
        update_post_meta($id,$key,wp_slash($b[$field]??''));
    }
    if(($b['posts_page']??0)===$id)update_option('page_for_posts',$id);
    if(empty($b['blog']))delete_post_meta($id,'_bc_blog_template');
    if(class_exists('\Elementor\Core\Files\CSS\Post')){ 
        $css=new \Elementor\Core\Files\CSS\Post($id);
        $css->delete(); 
    }
    return true;
}
