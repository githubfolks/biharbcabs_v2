<?php
if (!defined('ABSPATH')) exit;
function bc_defaults() {
 return array('header_background'=>'#ffffff','footer_background'=>'#030712','facebook'=>'','twitter'=>'','instagram'=>'','linkedin'=>'','primary'=>'#facc15','secondary'=>'#111827','topbar'=>true,'sticky'=>true,'language'=>true,'location_enabled'=>true,'location_key'=>'','phone'=>'+917070992170','phone_label'=>'070709 92170','whatsapp'=>'917070992170','email'=>'info@biharcabs.com','address'=>'Taxi Stand Rd, near Hanuman mandir pin code, Sarvoday Nagar, Purnia, Bihar 854301','footer_logo'=>'','footer_about'=>'The most trusted and reliable 24x7 cab service operating across Bihar, managed locally with pride.','copyright'=>'© 2026 BiharCabs. All Rights Reserved.','blog_style'=>'grid','contact_recipient'=>'','seo_description'=>'Looking for the best cab service in Patna, Bihar? Book affordable and reliable taxi service in Patna for outstation, airport drop, and local rides with Bihar Cabs.');
}
function bc_setting($key) { $defaults=bc_defaults(); $value=get_theme_mod('bc_'.$key,$defaults[$key]??''); return is_scalar($value)?$value:($defaults[$key]??''); }
function bc_color($value) {return is_string($value)?sanitize_hex_color($value):null;}
function bc_url($value) {return is_string($value)?esc_url_raw($value,array('https','http')):'';}
function bc_bool($value) {return (bool)$value;}
function bc_phone($value) { return preg_replace('/[^0-9+]/','',(is_scalar($value)?(string)$value:'')); }
function bc_digits($value) {return preg_replace('/\D/','',is_scalar($value)?(string)$value:'');}
function bc_blog_style($value) {return in_array($value,array('grid','list'),true)?$value:'grid';}
function bc_api_key($value) {return preg_replace('/[^a-zA-Z0-9._-]/','',is_scalar($value)?(string)$value:'');}
add_action('customize_register',function($c){
 $c->add_panel('bc_panel',array('title'=>__('Biharcabs Settings','biharcabs'),'priority'=>30));
 $sections=array('branding'=>'Colors & Branding','header'=>'Header & Contact','footer'=>'Footer','blog'=>'Blog Layout','integrations'=>'Language & Location API','seo'=>'SEO');
 foreach($sections as $id=>$title) $c->add_section('bc_'.$id,array('title'=>$title,'panel'=>'bc_panel'));
 $fields=array(
 'primary'=>array('branding','Primary color','color','bc_color'),
 'secondary'=>array('branding','Dark / secondary color','color','bc_color'),
 'header_background'=>array('header','Header background','color','bc_color'),
 'facebook'=>array('header','Facebook URL','url','bc_url'),
 'twitter'=>array('header','Twitter / X URL','url','bc_url'),
 'instagram'=>array('header','Instagram URL','url','bc_url'),
 'linkedin'=>array('header','LinkedIn URL','url','bc_url'),
 'footer_background'=>array('footer','Footer background','color','bc_color'),
 'topbar'=>array('header','Show contact top bar','checkbox','bc_bool'),
 'sticky'=>array('header','Enable sticky header','checkbox','bc_bool'),
 'phone'=>array('header','Phone (international format)','text','bc_phone'),
 'phone_label'=>array('header','Display phone number','text','sanitize_text_field'),
 'whatsapp'=>array('header','WhatsApp number (country code, digits only)','text','bc_digits'),
 'email'=>array('header','Public email address','email','sanitize_email'),
 'address'=>array('header','Business address','textarea','sanitize_textarea_field'),
 'footer_logo'=>array('footer','Footer logo','image','bc_url'),
 'footer_about'=>array('footer','Footer description','textarea','sanitize_textarea_field'),
 'copyright'=>array('footer','Copyright text','text','sanitize_text_field'),
 'blog_style'=>array('blog','Blog layout','select','bc_blog_style'),
 'language'=>array('integrations','Enable English / Hindi translator (GTranslate)','checkbox','bc_bool'),
 'location_enabled'=>array('integrations','Enable LocationIQ autocomplete and distance','checkbox','bc_bool'),
 'location_key'=>array('integrations','LocationIQ browser token','password','bc_api_key'),
 'contact_recipient'=>array('integrations','Contact enquiry recipient (blank = WordPress admin email)','email','sanitize_email'),
 'seo_description'=>array('seo','Home meta description (SEO plugins take priority)','textarea','sanitize_textarea_field')
 );
 foreach($fields as $key=>$f){
  $c->add_setting('bc_'.$key,array('default'=>bc_defaults()[$key],'sanitize_callback'=>$f[3],'capability'=>'edit_theme_options','transport'=>'refresh'));
  $args=array('label'=>$f[1],'section'=>'bc_'.$f[0],'type'=>$f[2]);
  if($key==='location_key') $args['description']='Use a browser/public token with HTTP referrer restrictions for your domain. The token is visible to visitors. Manual booking works without a token. Location data is sent to LocationIQ only during lookup.';
  if($key==='language') $args['description']='Loads a third-party translation widget. This translates display text; use a multilingual plugin for separate SEO language URLs.';
  if($key==='blog_style') $args['choices']=array('grid'=>'Grid','list'=>'List');
  if($f[2]==='color') $c->add_control(new WP_Customize_Color_Control($c,'bc_'.$key,$args));
  elseif($f[2]==='image') $c->add_control(new WP_Customize_Image_Control($c,'bc_'.$key,$args));
  else $c->add_control('bc_'.$key,$args);
 }
});
add_action('wp_head',function(){
 $primary=sanitize_hex_color(bc_setting('primary')); $secondary=sanitize_hex_color(bc_setting('secondary'));
 echo '<style id="bc-brand-colors">:root{--bc-primary:'.esc_attr($primary).';--bc-secondary:'.esc_attr($secondary).';}';
 if($primary!=='#facc15') echo ':root{--theme-color:'.esc_attr($primary).';--primary:'.esc_attr($primary).';}.theme-btn{background:'.esc_attr($primary).';}';
 if($secondary!=='#111827') echo ':root{--secondary:'.esc_attr($secondary).';}';
 echo '.header .main-navigation,.header .navbar{background:'.esc_attr(sanitize_hex_color(bc_setting('header_background'))).';}body .custom-footer{background:'.esc_attr(sanitize_hex_color(bc_setting('footer_background'))).';}';
 echo '</style>';
 if(!has_site_icon()) echo '<link rel="icon" href="'.esc_url(bc_asset('img/img/logo_bihar cabs.png')).'">';
},99);
