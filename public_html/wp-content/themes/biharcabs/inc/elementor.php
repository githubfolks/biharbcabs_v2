<?php
if(!defined('ABSPATH'))exit;
class Biharcabs_Demo_Widget extends \Elementor\Widget_Base {
 public function get_name(){return 'biharcabs-demo';}
 public function get_title(){return __('Biharcabs Demo','biharcabs');}
 public function get_icon(){return 'eicon-car';}
 public function get_categories(){return array('general');}
 protected function register_controls(){
  $this->start_controls_section('demo',array('label'=>'Demo content'));
  $this->add_control('demo_page',array('label'=>'Page design','type'=>\Elementor\Controls_Manager::SELECT,'default'=>'index','options'=>array('index'=>'Home','service'=>'Services','cities'=>'Cities','about'=>'About','contact'=>'Contact','fares'=>'Fares')));
  $this->add_control('editing_note',array('type'=>\Elementor\Controls_Manager::RAW_HTML,'raw'=>'<strong>This page is still one legacy demo widget.</strong><br>Clicking its text or images cannot open individual Elementor controls. To enable direct editing, open <a href="'.esc_url(admin_url('themes.php?page=biharcabs-setup')).'" target="_blank" rel="noopener noreferrer">Biharcabs Setup</a>, find this page and choose <strong>Convert and save backup</strong>. This loads the original demo as separate editable elements and backs up the current saved layout. Then reopen this page in Elementor.'));
  $r=new \Elementor\Repeater();
  $r->add_control('find',array('label'=>'Exact original text','type'=>\Elementor\Controls_Manager::TEXTAREA));
  $r->add_control('replace',array('label'=>'Replacement text','type'=>\Elementor\Controls_Manager::TEXTAREA));
  $this->add_control('copy_changes',array('label'=>'Edit demo text','type'=>\Elementor\Controls_Manager::REPEATER,'fields'=>$r->get_controls(),'title_field'=>'{{ find }}'));
  $images=new \Elementor\Repeater();
  $images->add_control('original',array('label'=>'Original filename (for example hero.webp)','type'=>\Elementor\Controls_Manager::TEXT));
  $images->add_control('image',array('label'=>'Replacement image','type'=>\Elementor\Controls_Manager::MEDIA));
  $this->add_control('image_changes',array('label'=>'Edit demo images','type'=>\Elementor\Controls_Manager::REPEATER,'fields'=>$images->get_controls(),'title_field'=>'{{ original }}'));
  $this->end_controls_section();
 }
 protected function render(){
  $s=$this->get_settings_for_display();
  $page=$s['demo_page']??'index';
  if(!in_array($page,array('index','service','cities','about','contact','fares'),true))return;
  $html=bc_fragment($page);$size=strlen($html);
  foreach(array_slice(is_array($s['copy_changes']??null)?$s['copy_changes']:array(),0,100) as $change){
   if(!is_array($change)||!is_string($change['find']??null)||!is_string($change['replace']??null))continue;
   $find=trim($change['find']);if($find===''||strlen($find)>500||strlen($change['replace'])>5000)continue;
   $find=esc_html($find);$replacement=esc_html($change['replace']);
   // Replace text nodes only, never scripts, attributes, styles or event handlers.
   $parts=preg_split('~(<script\b[\s\S]*?</script>|<style\b[\s\S]*?</style>|<[^>]+>)~i',$html,-1,PREG_SPLIT_DELIM_CAPTURE);
   foreach($parts as $i=>$part)if($i%2===0){
    $delta=substr_count($part,$find)*(strlen($replacement)-strlen($find));
    if($size+$delta>524288)continue;
    $parts[$i]=str_replace($find,$replacement,$part);$size+=$delta;
   }
   $html=implode('',$parts);
  }
  foreach(array_slice(is_array($s['image_changes']??null)?$s['image_changes']:array(),0,100) as $change){
   if(!is_array($change)||!is_string($change['original']??null)||!is_array($change['image']??null)||!is_string($change['image']['url']??null))continue;
   $file=basename($change['original']??'');$url=esc_url_raw($change['image']['url']??'',array('https','http'));
   if($file && $url)$html=str_replace(esc_url(bc_asset('img/img/'.$file)),esc_url($url),$html);
  }
  echo $html;
 }
}
