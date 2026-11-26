<?php
if (!defined('ABSPATH')) exit;

/**
 * Dynamic Route SEO Pages (WordPress <-> CRM).
 *
 * Serves /cab/<slug>/ (and /?bc_seo_route=<slug>) by fetching live route metadata
 * and best-fit CRM cab fares from GET /api/public/seo-routes/<slug>.
 * Emits SEO meta tags, TaxiService + FAQPage JSON-LD schema, and live booking cards.
 */
class BCGE_Seo_Routes {
    public static function init() {
        add_action('init', array(__CLASS__, 'add_rewrite_rules'));
        add_filter('query_vars', array(__CLASS__, 'register_query_vars'));
        add_action('template_redirect', array(__CLASS__, 'maybe_render_route_page'));
    }

    public static function add_rewrite_rules() {
        add_rewrite_rule('^cab/([a-z0-9-]+)/?$', 'index.php?bc_seo_route=$matches[1]', 'top');
    }

    public static function register_query_vars($vars) {
        $vars[] = 'bc_seo_route';
        return $vars;
    }

    private static function crm_base_url() {
        $card = BCGE_Rate_Card::get();
        return isset($card['crm_api_base_url']) ? rtrim(trim($card['crm_api_base_url']), '/') : '';
    }

    private static function proxy_cab_image($url) {
        if (empty($url) || !is_string($url)) return '';
        if (preg_match('#^/api/public/cab-images/([a-zA-Z0-9._-]+)$#', $url, $m)) {
            return add_query_arg('file', rawurlencode($m[1]), rest_url('biharcabs/v1/cab-image'));
        }
        return esc_url($url);
    }

    public static function maybe_render_route_page() {
        $slug = get_query_var('bc_seo_route');
        if (empty($slug) && isset($_GET['bc_seo_route'])) {
            $slug = sanitize_title(wp_unslash($_GET['bc_seo_route']));
        }
        if (empty($slug)) return;

        $slug = strtolower(preg_replace('/[^a-z0-9-]/', '', $slug));
        $crm_base = self::crm_base_url();
        if (empty($crm_base)) {
            status_header(503);
            wp_die('BiharCabs live route service is not configured.', 'Service Unavailable', array('response' => 503));
        }

        $res = wp_remote_get($crm_base . '/api/public/seo-routes/' . rawurlencode($slug), array(
            'timeout' => 8,
            'headers' => array('Accept' => 'application/json'),
        ));

        if (is_wp_error($res) || wp_remote_retrieve_response_code($res) !== 200) {
            status_header(404);
            wp_die('Route page not found.', 'Not Found', array('response' => 404));
        }

        $data = json_decode(wp_remote_retrieve_body($res), true);
        if (empty($data['success']) || empty($data['route'])) {
            status_header(404);
            wp_die('Route page not found.', 'Not Found', array('response' => 404));
        }

        $route = $data['route'];
        $plans = isset($data['plans']) && is_array($data['plans']) ? $data['plans'] : array();
        $faqs  = isset($route['faqs_json']) && is_array($route['faqs_json']) ? $route['faqs_json'] : array();
        $canonical = home_url('/cab/' . rawurlencode($slug) . '/');

        // Related routes for internal SEO linking
        $list_res = wp_remote_get($crm_base . '/api/public/seo-routes', array('timeout' => 5));
        $related = array();
        if (!is_wp_error($list_res) && wp_remote_retrieve_response_code($list_res) === 200) {
            $list_json = json_decode(wp_remote_retrieve_body($list_res), true);
            foreach (($list_json['routes'] ?? array()) as $item) {
                if (($item['slug'] ?? '') !== $slug) $related[] = $item;
            }
        }

        $schema = array(
            '@context' => 'https://schema.org',
            '@graph'   => array(
                array(
                    '@type'       => 'TaxiService',
                    'name'        => $route['hero_heading'],
                    'description' => $route['meta_description'],
                    'url'         => $canonical,
                    'provider'    => array('@type' => 'Organization', 'name' => 'BiharCabs.com', 'url' => home_url('/')),
                    'areaServed'  => array_values(array_filter(array($route['origin_city'], $route['destination_city']))),
                ),
            ),
        );
        if (!empty($faqs)) {
            $faq_entities = array();
            foreach ($faqs as $f) {
                if (empty($f['q']) || empty($f['a'])) continue;
                $faq_entities[] = array(
                    '@type' => 'Question',
                    'name'  => $f['q'],
                    'acceptedAnswer' => array('@type' => 'Answer', 'text' => $f['a']),
                );
            }
            if (!empty($faq_entities)) {
                $schema['@graph'][] = array('@type' => 'FAQPage', 'mainEntity' => $faq_entities);
            }
        }

        status_header(200);
        header('Content-Type: text/html; charset=utf-8');
        ?>
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title><?php echo esc_html($route['page_title']); ?></title>
  <meta name="description" content="<?php echo esc_attr($route['meta_description']); ?>" />
  <link rel="canonical" href="<?php echo esc_url($canonical); ?>" />
  <script type="application/ld+json"><?php echo wp_json_encode($schema, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE); ?></script>
  <style>
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; line-height: 1.5; }
    .bc-wrap { max-width: 1120px; margin: 0 auto; padding: 24px 16px 56px; }
    .bc-hero { background: linear-gradient(135deg, #0f172a, #1e293b); color: #fff; padding: 36px 28px; border-radius: 18px; margin-bottom: 28px; }
    .bc-hero h1 { margin: 0 0 10px; font-size: 30px; line-height: 1.2; }
    .bc-hero p { margin: 0 0 16px; color: #cbd5e1; max-width: 720px; }
    .bc-badges { display: flex; flex-wrap: wrap; gap: 10px; font-size: 13px; font-weight: 600; }
    .bc-badge { background: rgba(255,255,255,0.12); padding: 6px 12px; border-radius: 999px; }
    .bc-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(290px, 1fr)); gap: 18px; margin: 20px 0 36px; }
    .bc-card { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; overflow: hidden; display: flex; flex-direction: column; box-shadow: 0 2px 6px rgba(15,23,42,0.05); }
    .bc-card img { width: 100%; height: 165px; object-fit: cover; background: #f1f5f9; }
    .bc-card-body { padding: 16px; flex: 1; display: flex; flex-direction: column; justify-content: space-between; gap: 12px; }
    .bc-price { font-size: 22px; font-weight: 800; color: #c2410c; }
    .bc-btn { display: inline-block; text-align: center; background: #ea580c; color: #fff; text-decoration: none; padding: 10px 14px; border-radius: 10px; font-weight: 700; font-size: 14px; }
    .bc-btn:hover { background: #c2410c; }
    .bc-faq { background: #fff; border: 1px solid #e2e8f0; border-radius: 14px; padding: 20px; margin-bottom: 28px; }
    .bc-faq details { border-top: 1px solid #e2e8f0; padding: 12px 0; }
    .bc-faq details:first-of-type { border-top: 0; }
    .bc-faq summary { font-weight: 700; cursor: pointer; }
    .bc-links { display: flex; flex-wrap: wrap; gap: 10px; }
    .bc-links a { background: #fff; border: 1px solid #cbd5e1; color: #0f172a; padding: 8px 14px; border-radius: 999px; text-decoration: none; font-size: 13px; font-weight: 600; }
  </style>
</head>
<body>
  <div class="bc-wrap">
    <div style="margin-bottom:14px;"><a href="<?php echo esc_url(home_url('/')); ?>" style="color:#ea580c;font-weight:700;text-decoration:none;">← Back to BiharCabs.com</a></div>
    <section class="bc-hero">
      <h1><?php echo esc_html($route['hero_heading']); ?></h1>
      <?php if (!empty($route['intro_copy'])): ?>
        <p><?php echo esc_html($route['intro_copy']); ?></p>
      <?php endif; ?>
      <div class="bc-badges">
        <span class="bc-badge">Route: <?php echo esc_html($route['origin_city'] . (!empty($route['destination_city']) ? ' → ' . $route['destination_city'] : '')); ?></span>
        <?php if (!empty($route['distance_km'])): ?>
          <span class="bc-badge">Distance: <?php echo esc_html($route['distance_km']); ?> km</span>
        <?php endif; ?>
        <?php if (!empty($route['drive_time_text'])): ?>
          <span class="bc-badge">Est. Drive: <?php echo esc_html($route['drive_time_text']); ?></span>
        <?php endif; ?>
        <span class="bc-badge">KYC Verified Drivers</span>
      </div>
    </section>

    <h2 style="margin:0 0 8px;">Live AC Cab Fares (GST Inclusive)</h2>
    <?php if (empty($plans)): ?>
      <p style="color:#475569;">Live fare packages are currently being updated. <a href="<?php echo esc_url(home_url('/')); ?>">Request an instant quote on BiharCabs.com</a>.</p>
    <?php else: ?>
      <div class="bc-grid">
        <?php foreach ($plans as $p):
          $img = self::proxy_cab_image($p['image_url'] ?? '');
          $book_url = add_query_arg(array(
            'origin' => $route['origin_city'],
            'destination' => $route['destination_city'] ?? '',
            'booking_type' => $route['booking_type'],
          ), home_url('/#book-now'));
        ?>
          <article class="bc-card">
            <?php if ($img): ?><img src="<?php echo esc_url($img); ?>" alt="<?php echo esc_attr($p['cab_name']); ?>" loading="lazy" /><?php endif; ?>
            <div class="bc-card-body">
              <div>
                <div style="font-size:12px;font-weight:700;color:#475569;text-transform:uppercase;"><?php echo esc_html($p['cab_name']); ?></div>
                <div style="font-size:17px;font-weight:800;margin:2px 0 6px;"><?php echo esc_html($p['name']); ?></div>
                <div class="bc-price">₹<?php echo esc_html(number_format((float)$p['total_payment'], 0)); ?></div>
                <div style="font-size:12px;color:#475569;margin-top:4px;">
                  Includes <?php echo esc_html($p['included_km']); ?> km / <?php echo esc_html($p['included_hours']); ?> hrs &bull; Extra ₹<?php echo esc_html($p['extra_km_charge']); ?>/km
                </div>
              </div>
              <a class="bc-btn" href="<?php echo esc_url($book_url); ?>">Book <?php echo esc_html($p['cab_name']); ?> Now</a>
            </div>
          </article>
        <?php endforeach; ?>
      </div>
    <?php endif; ?>

    <?php if (!empty($faqs)): ?>
      <section class="bc-faq">
        <h2 style="margin:0 0 8px;">Frequently Asked Questions</h2>
        <?php foreach ($faqs as $f): ?>
          <details>
            <summary><?php echo esc_html($f['q'] ?? ''); ?></summary>
            <p style="margin:8px 0 0;color:#334155;font-size:14px;"><?php echo esc_html($f['a'] ?? ''); ?></p>
          </details>
        <?php endforeach; ?>
      </section>
    <?php endif; ?>

    <?php if (!empty($related)): ?>
      <section>
        <h3 style="margin:0 0 12px;font-size:16px;">Popular BiharCabs Routes</h3>
        <div class="bc-links">
          <?php foreach ($related as $rel): ?>
            <a href="<?php echo esc_url(add_query_arg('bc_seo_route', $rel['slug'], home_url('/'))); ?>">
              <?php echo esc_html($rel['hero_heading']); ?>
            </a>
          <?php endforeach; ?>
        </div>
      </section>
    <?php endif; ?>
  </div>
</body>
</html>
        <?php
        exit;
    }
}
