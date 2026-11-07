<?php
if(!defined('ABSPATH'))exit;
class Biharcabs_Journal_Header_Widget extends \Elementor\Widget_Base {
 public function get_name(){return 'biharcabs-journal-header';}public function get_title(){return 'Biharcabs Journal Header';}public function get_icon(){return 'eicon-post-title';}public function get_categories(){return array('general');}
 protected function register_controls(){
  $this->start_controls_section('content',array('label'=>'Journal header'));
  $this->add_control('context',array('type'=>\Elementor\Controls_Manager::SELECT,'label'=>'Title source','options'=>array('blog'=>'Custom title','archive'=>'Current archive / search'),'default'=>'blog'));
  foreach(array('eyebrow'=>array('Small label','THE BIHARCABS JOURNAL'),'title'=>array('Title','Travel stories & useful guides'),'intro'=>array('Introduction','Ideas for your next journey, local insights and practical travel advice.')) as $key=>$control)$this->add_control($key,array('type'=>\Elementor\Controls_Manager::TEXTAREA,'label'=>$control[0],'default'=>$control[1]));
  $this->end_controls_section();
 }
 protected function render(){
  $s=$this->get_settings_for_display();foreach(array('title','intro','eyebrow') as $key)if(!is_string($s[$key]??null))$s[$key]='';
  if(($s['context']??'blog')==='archive'){
   if(is_search()){$s['title']=sprintf(__('Search results for: %s','biharcabs'),get_search_query());$s['intro']='';}
   elseif(is_archive()){$s['title']=wp_strip_all_tags(get_the_archive_title());$s['intro']=get_the_archive_description();}
  }
  bc_journal_header($s['title'],$s['intro'],$s['eyebrow']);
 }
}
class Biharcabs_Article_Widget extends \Elementor\Widget_Base {
 public function get_name(){return 'biharcabs-article';}public function get_title(){return 'Biharcabs Article Section';}public function get_icon(){return 'eicon-post-content';}public function get_categories(){return array('general');}
 protected function register_controls(){
  $this->start_controls_section('content',array('label'=>'Article section'));
  $this->add_control('part',array('type'=>\Elementor\Controls_Manager::SELECT,'label'=>'Section','options'=>array('header'=>'Title, author and featured image','content'=>'Article content, share links and sidebar','related'=>'More stories'),'default'=>'content'));
  $this->add_control('help',array('type'=>\Elementor\Controls_Manager::RAW_HTML,'raw'=>'This displays the current post. Edit each article under Posts → Edit with Elementor. Use this template to reorder sections, adjust spacing and add other Elementor widgets.'));
  foreach(array('sidebar_title'=>array('Sidebar title','Ready to explore Bihar?'),'sidebar_text'=>array('Sidebar text','Plan your trip with a local team. Tell us where you want to go.'),'sidebar_button'=>array('Sidebar button','Plan my ride'),'related_title'=>array('More stories heading','More from the journal')) as $key=>$control)$this->add_control($key,array('type'=>\Elementor\Controls_Manager::TEXTAREA,'label'=>$control[0],'default'=>$control[1]));
  $this->end_controls_section();
 }
 protected function render(){$s=$this->get_settings_for_display();$part=$s['part']??'content';if(!in_array($part,array('header','content','related'),true))return;bc_article_part($part,$s);}
}
