<?php
if(!defined('ABSPATH'))exit;
class Biharcabs_Form_Widget extends \Elementor\Widget_Base {
 public function get_name(){return 'biharcabs-form';}public function get_title(){return 'Biharcabs Booking / Contact Form';}public function get_icon(){return 'eicon-form-horizontal';}public function get_categories(){return array('general');}
 protected function register_controls(){
  $this->start_controls_section('content',array('label'=>'Form content'));
  $options=array();foreach(bc_native_catalog()['forms'] as $key=>$form)$options[$key]=ucfirst($form['page']).' — '.$form['kind'].' ('.$key.')';
  $this->add_control('form_source',array('type'=>\Elementor\Controls_Manager::SELECT,'label'=>'Form design','options'=>$options,'default'=>array_key_first($options)));
  $this->add_control('bc_source',array('type'=>\Elementor\Controls_Manager::HIDDEN));
  $r=new \Elementor\Repeater();$r->add_control('key',array('type'=>\Elementor\Controls_Manager::HIDDEN));$r->add_control('label',array('type'=>\Elementor\Controls_Manager::HIDDEN));$r->add_control('value',array('type'=>\Elementor\Controls_Manager::TEXTAREA,'label'=>'Text / placeholder'));
  $this->add_control('copy',array('label'=>'Labels, placeholders, options and button text','type'=>\Elementor\Controls_Manager::REPEATER,'fields'=>$r->get_controls(),'title_field'=>'{{ label }}','prevent_empty'=>false));
  $this->add_control('note',array('type'=>\Elementor\Controls_Manager::RAW_HTML,'raw'=>'Field labels are editable; required field structure stays intact for secure booking/enquiry handling. API token, recipient and WhatsApp number are in Appearance → Customize.'));
  $this->end_controls_section();
 }
 protected function render(){
  $s=$this->get_settings_for_display();$key=$s['form_source']??'';if(!is_string($key))return;$form=bc_native_catalog()['forms'][$key]??null;if(!$form)return;
  $values=array();foreach($form['fields'] as $field)$values[$field['key']]=$field['value'];
  foreach(array_slice(is_array($s['copy']??null)?$s['copy']:array(),0,100) as $item)if(is_array($item)&&is_string($item['key']??null)&&array_key_exists($item['key'],$values)&&is_string($item['value']??null))$values[$item['key']]=mb_substr($item['value'],0,2000);
  $tokens=array();foreach($values as $key=>$value)$tokens['{{BC_COPY_'.$key.'}}']=esc_html($value);
  $html=strtr($form['html'],$tokens);$p=new WP_HTML_Tag_Processor($html);$prefix='bc-form-'.sanitize_html_class($this->get_id());$ids=array();
  while($p->next_tag()){
   $tag=$p->get_tag();$old=$p->get_attribute('id');if($old){$new=$prefix.'-'.sanitize_html_class($old);$ids[$old]=$new;$p->set_attribute('id',$new);}
   $p->remove_attribute('onclick');
   if($tag==='FORM'){$p->set_attribute('id',$prefix);$p->set_attribute('data-bc-'.$form['kind'],'true');$p->set_attribute('action','#');}
   if($tag==='BUTTON')$p->set_attribute('type','submit');
   foreach(array('pickup_location'=>'pickup','drop_location'=>'drop','auto_detect_btn'=>'auto','estimated_distance'=>'distance','fare_estimate_box'=>'estimate','pickup_date'=>'date','pickup_time'=>'time','date_instant'=>'date','time_instant'=>'time','name_instant'=>'name','phone_instant'=>'phone','passengers_instant'=>'passengers','category_instant'=>'category','instructions_instant'=>'instructions') as $match=>$role){if(is_string($old)&&str_starts_with($old,$match))$p->set_attribute('data-bc-field',$role);}
  }
  $html=$p->get_updated_html();$p=new WP_HTML_Tag_Processor($html);while($p->next_tag('LABEL')){$for=$p->get_attribute('for');if(isset($ids[$for]))$p->set_attribute('for',$ids[$for]);}$html=$p->get_updated_html();
  if($form['kind']==='contact')$html=preg_replace('~(<form\b[^>]*>)~','$1<div class="bc-honeypot" aria-hidden="true"><label>Leave blank<input name="website" tabindex="-1" autocomplete="off"></label></div><div class="bc-contact-status" role="status" aria-live="polite"></div>',$html,1);
  echo $html;
 }
}
class Biharcabs_FAQ_Widget extends \Elementor\Widget_Base {
 public function get_name(){return 'biharcabs-faq';}public function get_title(){return 'Biharcabs FAQ';}public function get_icon(){return 'eicon-accordion';}public function get_categories(){return array('general');}
 protected function register_controls(){
  $this->start_controls_section('faq',array('label'=>'Questions and answers'));
  $this->add_control('bc_source',array('type'=>\Elementor\Controls_Manager::HIDDEN));
  $r=new \Elementor\Repeater();$r->add_control('question',array('type'=>\Elementor\Controls_Manager::TEXT,'label'=>'Question'));$r->add_control('answer',array('type'=>\Elementor\Controls_Manager::WYSIWYG,'label'=>'Answer'));
  $this->add_control('items',array('type'=>\Elementor\Controls_Manager::REPEATER,'fields'=>$r->get_controls(),'title_field'=>'{{ question }}','default'=>array(array('question'=>'How can I book a cab?','answer'=>'Call us or send your trip details on WhatsApp.'))));
  $this->end_controls_section();
 }
 protected function render(){
  $s=$this->get_settings_for_display();$base='bc-faq-'.sanitize_html_class($this->get_id());echo '<div class="accordion custom-accordion" id="'.esc_attr($base).'">';
  foreach(array_slice(is_array($s['items']??null)?$s['items']:array(),0,100) as $i=>$item){if(!is_array($item)||!is_string($item['question']??null)||!is_string($item['answer']??null))continue;$id=$base.'-'.$i;
   echo '<div class="accordion-item"><h2 class="accordion-header"><button class="accordion-button'.($i?' collapsed':'').'" type="button" data-bs-toggle="collapse" data-bs-target="#'.esc_attr($id).'" aria-expanded="'.($i?'false':'true').'" aria-controls="'.esc_attr($id).'">'.esc_html($item['question']).'</button></h2><div id="'.esc_attr($id).'" class="accordion-collapse collapse'.($i?'':' show').'" data-bs-parent="#'.esc_attr($base).'"><div class="accordion-body">'.wp_kses_post(mb_substr($item['answer'],0,20000)).'</div></div>';
  }echo '</div>';
 }
}
class Biharcabs_Posts_Widget extends \Elementor\Widget_Base {
 public function get_name(){return 'biharcabs-posts';}public function get_title(){return 'Biharcabs Blog Posts';}public function get_icon(){return 'eicon-posts-grid';}public function get_categories(){return array('general');}
 protected function register_controls(){
  $this->start_controls_section('posts',array('label'=>'Blog posts'));
  $this->add_control('query_source',array('type'=>\Elementor\Controls_Manager::SELECT,'label'=>'Posts to show','options'=>array('latest'=>'Latest posts','archive'=>'Current archive / search'),'default'=>'latest'));
  $this->add_control('show_categories',array('type'=>\Elementor\Controls_Manager::SWITCHER,'label'=>'Category navigation','default'=>'yes'));
  $this->add_control('layout',array('type'=>\Elementor\Controls_Manager::SELECT,'label'=>'Layout','options'=>array('grid'=>'Grid','list'=>'List'),'default'=>'grid'));
  $this->add_control('count',array('type'=>\Elementor\Controls_Manager::NUMBER,'label'=>'Posts per page','min'=>1,'max'=>30,'default'=>9));
  $this->add_control('more',array('type'=>\Elementor\Controls_Manager::TEXT,'label'=>'Read more text','default'=>'Read more'));
  $this->add_control('empty',array('type'=>\Elementor\Controls_Manager::TEXT,'label'=>'Empty message','default'=>'No posts yet. Add your first article under Posts.'));
  $this->end_controls_section();
 }
 protected function render(){
  $s=$this->get_settings_for_display();$page=max(1,absint(get_query_var('paged')),absint(get_query_var('page')));$count=max(1,min(30,absint(is_scalar($s['count']??null)?$s['count']:9)));
  global $wp_query;$archive=($s['query_source']??'latest')==='archive'&&(is_archive()||is_search()||is_home());
  $q=$archive?clone $wp_query:new WP_Query(array('post_type'=>'post','post_status'=>'publish','posts_per_page'=>$count,'paged'=>$page,'ignore_sticky_posts'=>true));
  echo '<div class="bc-journal-feed">';if(($s['show_categories']??'yes')==='yes')bc_blog_category_nav();
  echo '<div class="bc-journal-'.esc_attr(bc_blog_style($s['layout']??'grid')).'">';
  while($q->have_posts()){$q->the_post();bc_post_card(is_string($s['more']??null)?$s['more']:'Read story');}
  if(!$q->post_count)echo '<p class="bc-journal-empty">'.esc_html(is_string($s['empty']??null)?$s['empty']:'No stories found.').'</p>';
  echo '</div><nav class="bc-pagination" aria-label="Blog pages">'.wp_kses_post((string)paginate_links(array('total'=>$q->max_num_pages,'current'=>$page))).'</nav></div>';wp_reset_postdata();
 }
}
