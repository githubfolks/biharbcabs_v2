<?php
if (!defined('ABSPATH')) exit;
/** Atomically reserve a slot across PHP workers, including with a persistent object cache. */
function bc_acquire_contact_slot($key, $seconds = 60) {
 global $wpdb;
 $name = 'bc_contact_slot_' . hash('sha256', $key);
 $now = time();
 $until = (string) ($now + $seconds);
 if (add_option($name, $until, '', false)) return true;
 $won = $wpdb->query($wpdb->prepare(
  "UPDATE {$wpdb->options} SET option_value = %s WHERE option_name = %s AND CAST(option_value AS UNSIGNED) <= %d",
  $until, $name, $now
 ));
 if ($won === 1) { wp_cache_delete($name, 'options'); return true; }
 return false;
}
function bc_cleanup_contact_slots() {
 global $wpdb;
 $cutoff=time()-DAY_IN_SECONDS;
 $names=$wpdb->get_col($wpdb->prepare(
  "SELECT option_name FROM {$wpdb->options} WHERE option_name LIKE %s AND CAST(option_value AS UNSIGNED) < %d LIMIT 500",
  $wpdb->esc_like('bc_contact_slot_').'%', $cutoff
 ));
 foreach($names as $name){
  $wpdb->query($wpdb->prepare("DELETE FROM {$wpdb->options} WHERE option_name = %s AND CAST(option_value AS UNSIGNED) < %d",$name,$cutoff));
  wp_cache_delete($name,'options');
 }
}
add_action('bc_cleanup_contact_slots', 'bc_cleanup_contact_slots');
function bc_contact(){
 if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
  header('Allow: POST');
  wp_send_json_error(array('message'=>__('Use POST to submit this form.','biharcabs')),405);
 }
 if ((int) ($_SERVER['CONTENT_LENGTH'] ?? 0) > 16384) wp_send_json_error(array('message'=>'Request is too large.'),413);
 $limits = array('nonce'=>64, 'website'=>200, 'name'=>150, 'phone'=>40, 'email'=>254, 'subject_dropdown'=>150, 'message'=>5000);
 foreach ($limits as $field=>$max) {
  if (isset($_POST[$field]) && (!is_string($_POST[$field]) || strlen(wp_unslash($_POST[$field])) > $max)) {
   wp_send_json_error(array('message'=>__('Invalid or oversized form field.','biharcabs')),400);
  }
 }
 $nonce = isset($_POST['nonce']) ? wp_unslash($_POST['nonce']) : '';
 // Read only POST, never a query-string or cookie nonce.
 if (!wp_verify_nonce($nonce,'bc_contact')) wp_send_json_error(array('message'=>__('Session expired. Refresh and try again.','biharcabs')),403);
 if (!empty($_POST['website'])) wp_send_json_error(array('message'=>'Unable to submit.'),400);
 $raw=array();
 foreach(array('name','phone','email','subject_dropdown','message') as $field) $raw[$field]=wp_unslash($_POST[$field]??'');
 foreach(array('name','phone','email','subject_dropdown') as $field) {
  if (preg_match('/[\x00-\x1F\x7F]/', $raw[$field])) wp_send_json_error(array('message'=>'Invalid form field.'),400);
 }
 $name=sanitize_text_field($raw['name']);
 $phone=bc_phone($raw['phone']);
 $email=sanitize_email($raw['email']);
 $subject=sanitize_text_field($raw['subject_dropdown']) ?: 'General Enquiry';
 $message=sanitize_textarea_field($raw['message']);
 $digits=preg_replace('/\D/','',$phone);
 if (!$name || !trim($message) || !preg_match('/^\+?[0-9 ().-]+$/D',$raw['phone']) || strlen($digits)<7 || strlen($digits)>15 || ($raw['email']!=='' && (!is_email($raw['email']) || $raw['email']!==$email))) {
  wp_send_json_error(array('message'=>__('Enter a name, valid phone number, email (if provided) and message.','biharcabs')),400);
 }
 $ip=is_string($_SERVER['REMOTE_ADDR']??null)?$_SERVER['REMOTE_ADDR']:'';
 if (!bc_acquire_contact_slot(hash_hmac('sha256',$ip,wp_salt('nonce')))) {
  header('Retry-After: 60');
  wp_send_json_error(array('message'=>__('Please wait a minute before sending another message.','biharcabs')),429);
 }
 if (!wp_next_scheduled('bc_cleanup_contact_slots')) wp_schedule_event(time()+HOUR_IN_SECONDS,'daily','bc_cleanup_contact_slots');
 $recipient=bc_setting('contact_recipient')?:get_option('admin_email');
 if (!is_string($recipient) || !is_email($recipient)) wp_send_json_error(array('message'=>__('Contact email is not configured. Please call or WhatsApp us.','biharcabs')),503);
 $headers=$email?array('Reply-To: '.$email):array();
 $sent=wp_mail($recipient,'Biharcabs enquiry: '.$subject,"Name: $name\nPhone: $phone\nEmail: $email\n\n$message",$headers);
 if(!$sent)wp_send_json_error(array('message'=>__('Message could not be sent. Please call or WhatsApp us.','biharcabs')),500);
 wp_send_json_success(array('message'=>__('Your message has been sent. We will contact you soon.','biharcabs')));
}
add_action('wp_ajax_bc_contact','bc_contact');
add_action('wp_ajax_nopriv_bc_contact','bc_contact');
