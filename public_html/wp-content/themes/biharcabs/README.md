# Biharcabs WordPress Theme

Author: Biharcabs · Version: 1.1.2 · PHP 8.0+ · WordPress 6.2+

## Install

1. WordPress → Appearance → Themes → Add New → Upload Theme → choose `biharcabs.zip` → Activate.
2. Open Appearance → Biharcabs Setup → Import all 7 demo pages. Select the homepage checkbox if you want these pages to become your homepage/blog.
3. If you want Elementor demo editing, install/activate Elementor **before** import and select the Elementor checkbox. Edited content and existing Elementor layouts are preserved; empty published pages receive demo content.
4. Appearance → Customize → Site Identity: upload the header logo and site icon.
5. Appearance → Customize → Biharcabs Settings: configure colors, header/footer backgrounds, contact details, social links, footer logo/text, sticky header, blog grid/list, language and API settings.

## Original design and demo content

Home, Services, Cities, About, Contact and Fares use the supplied `deploy/Public` HTML, CSS, images and booking flow. Header, footer, mobile controls, WhatsApp buttons, modal, FAQ and route inputs are retained. All links point to WordPress pages and theme assets.

The supplied Public folder has no blog.html/articles: the theme supplies a real WordPress blog and post templates, without inventing demo articles. Existing source demo prices, claims and testimonial copy remain unchanged. Fares had two broken image references; the taxi icon was recovered from the supplied reference folder and its missing breadcrumb background uses an existing hero image. Stray control characters from the source were removed. Non-verifiable Product rating markup was replaced with factual TaxiService schema.

## Elementor

Elementor Free can edit all seven demo pages. Version 1.1.2 imports native headings, text, images, buttons and containers, plus editable Biharcabs booking/contact forms and FAQ widgets. Use the Navigator to select each section. Form labels, placeholders and options are editable; their required structure stays connected to the secure enquiry and LocationIQ integrations. Image alt text is under Advanced → Biharcabs original design. The original HTML/CSS/assets are retained and adapted to Elementor wrappers; pixel-perfect equivalence has not been visually verified.

**Upgrade:** Activate Elementor, then open Appearance → Biharcabs Setup and run **Import all 7 demo pages** with Elementor selected. Missing/empty pages and untouched old demos are converted. Edited pages and saved Elementor layouts are preserved. To replace an edited old demo with granular sections, expand **Convert to editable demo sections** beside that page and choose **Convert and save backup**. **Restore previous layout** restores the saved pre-conversion content. Review the page before publishing further edits.

The Blog page is a regular Elementor page with a journal header and live Posts widget; it is deliberately not assigned as WordPress's posts page. Appearance → Biharcabs Setup also provides **Edit archive layout with Elementor** and **Edit single layout with Elementor**. These templates work with Elementor Free. The archive widget follows the current category/tag/search; the single layout uses dynamic article sections. Edit each article under Posts → Edit with Elementor (enable Posts under Elementor → Settings if that option is disabled). You can change/reorder the template sections and add normal Elementor widgets. Article sidebar copy and related-story heading have their own controls. Category/tag names and article titles, featured images and content come from WordPress.

The redesigned journal includes responsive cards, categories, search, reading time, featured images, author information, share links, pagination and more stories. It uses actual published posts; no invented demo articles are imported. The legacy **Biharcabs Demo** widget and shortcodes remain available for compatibility.

Elementor Pro Theme Builder can replace the header and footer using display conditions. Elementor Canvas intentionally omits the theme header/footer. Elementor Full Width retains them.

## Location and language

The original provider is **LocationIQ**. Add your browser/public token under Language & Location API. Restrict the token to your production domain in the LocationIQ account; this browser token is visible to visitors. The source site's token is not shipped. Autocomplete is restricted to India. Reverse geocoding uses the visitor's explicit location action and browser permission. Route distance uses LocationIQ's driving API; your plan must support those endpoints. HTTPS is required for geolocation on production domains.

Without a token, users can type addresses and submit WhatsApp bookings. Failed lookups also fall back to manual entry. A distance is an estimate, not a confirmed fare. Booking is a WhatsApp enquiry; there is no payment collection or reservation database.

The English/Hindi switch uses the existing GTranslate service and can be disabled. This is browser translation, not separate indexable language URLs. A multilingual plugin is needed for translated SEO URLs/content.

## Contact form and email

The contact form uses WordPress `wp_mail`, not the source's embedded third-party access token. Configure a recipient (defaults to the WordPress admin email), configure mail/SMTP on your host, and test actual delivery. Mail submission is protected with a nonce, input validation, a honeypot, an atomic per-IP cooldown and escaped output. A successful wp_mail return indicates acceptance by the mail transport, not guaranteed inbox delivery. WhatsApp enquiries still work separately.

## SEO

WordPress title tags, canonical URLs, core XML sitemaps, responsive layout, semantic templates, featured images, descriptions and TaxiService structured data are supported. The theme defers its descriptions/schema/title override when Yoast, Rank Math, AIOSEO or SEOPress is detected. Configure a unique site title, real business details and image alt text; use an SEO plugin for advanced metadata. No ranking guarantee is implied.

## Validation

Tested in an isolated local WordPress 6.9.4 installation, PHP 8.3.33, Elementor 4.3.1. PHP/JS syntax, theme activation, shortcode and Elementor imports, idempotent import, Customizer registration, page/asset links, HTTP routes, unique layout IDs, escaped Elementor text, WhatsApp payload, invalid contact nonce and mocked contact success/error/spam/rate-limit flows were checked. Version 1.0.2 removes unused legacy JavaScript libraries completely; booking date/time inputs use native browser controls. See SECURITY.md for the security audit and its limits.

Visual browser comparison could not be completed because no browser was available through the connected browser tool. Live LocationIQ requests, actual email inbox delivery and Elementor Pro Theme Builder require configuration/testing on the target installation. One PHP deprecation was logged inside Elementor's own API during local activation; no unresolved theme PHP errors were observed in the final checks.

Source vendor comments and third-party asset notices are retained in bundled files. The WordPress theme author is Biharcabs.

## Import recovery (1.0.2)

Seeing the Home preview after activation does not mean the pages were imported. Open Appearance → Biharcabs Setup and click **Import all 7 demo pages**. The status table lists Home, Services, Cities, About, Contact, Fares and Blog with View/Edit links. You can safely rerun after a partial import: missing pages are retried and empty published pages repaired. Drafts and edited content are preserved and clearly identified. A failed page no longer stops later pages. If ready pages are missing only from your navigation, add them to your Primary Menu.

Version 1.1.2 also checks granular Elementor rendering for all seven pages, safe form labels, encoded native booking payloads, nonce-bearing contact requests, retained category queries, protected article content and Elementor-authored post content within the single template. Browser tools reported no connected browser, so desktop/mobile pixel comparison remains pending.

## Homepage rendering fix 1.1.2 — 29 September 2026

An assigned static homepage now always renders through WordPress `the_content`, allowing Elementor to read its saved document metadata even when raw `post_content` is empty. Previously that case displayed the original Home demo instead. A deliberately empty assigned page now stays empty; demo preview remains only when no static homepage is being rendered. Tested Elementor document saves, subsequent edits, empty metadata-backed page content and the regular page template. This fixes a confirmed homepage display defect; it does not establish or repair an unobserved hosting-wide Elementor save/cache issue.
