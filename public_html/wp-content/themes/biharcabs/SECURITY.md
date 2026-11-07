# Security audit — Biharcabs 1.0.1

Reviewed 24 September 2026. Scope: the generated Biharcabs theme, its bundled assets, and task-created QA/build helpers. The original static deployment, hosting configuration, other WordPress plugins and a production installation were not comprehensively penetration-tested.

## Findings addressed

| Finding | Change | Verification |
| --- | --- | --- |
| Raw Elementor repeater labels were compiled as unescaped HTML and inserted into the editor with `.html()` | Changed both labels to escaped interpolation | Reproduced raw/escaped behavior using the installed WordPress template engine; malicious frontend replacements tested too |
| Repeated text replacements could expand page output until PHP exhausted memory | Bounded replacement count, input sizes and total output; malformed settings rejected | Five hostile widget cases, including repeated expansion, traversal and script URLs |
| Public contact handler accepted malformed/oversized fields and did not explicitly enforce POST | POST-only, POST-source nonce, string/size validation, phone/email validation, control-character rejection, trusted recipient validation | 13 HTTP negative cases returned expected 400/403/405/413 responses; no email sent |
| Contact cooldown used a non-atomic read/write, allowing concurrent requests through | Database-backed atomic reservation; expired-slot renewal and bounded cleanup | Exactly one of six simultaneous PHP workers obtained a slot; expiry and cleanup tested |
| Demo importer permitted GET with a valid nonce; reading settings did not separately require manage_options | POST-only and typed inputs; manage_options required to replace front/posts page | Five denied permission/nonce/method cases; page count unchanged |
| Legacy vendor code included jQuery UI 1.12.1 and Magnific Popup 1.1.0 | Removed unused vendor files and initializers; retained demo UI behavior using native browser APIs and Bootstrap | Asset inventory, PHP/JS checks, 10 WordPress routes and native UI mocks |
| Mirrored hosting/error HTML documents were packaged under CSS assets | Removed seven unrelated HTML documents from assets | Bundle rejects executable/mirrored HTML under assets |
| QA/build PHP utilities under htdocs were not CLI-restricted | Added CLI guards and Apache deny rules for testing/tools directories | Helper guards inspected; no QA files allowed in the theme ZIP |
| Additional output handling | Sanitized WhatsApp digits at render time; typed settings; literal callback replacement for menus/footer copy | Sanitizer, escaping and package regression checks |

## Dependency evidence

- jQuery UI 1.12.1 was **packaged but not enqueued** in version 1.0.0. The downloaded advisory data matched CVE-2021-41182, CVE-2021-41183, CVE-2021-41184 and CVE-2022-31160. It is now absent. These matches identify vulnerable library code, not proof that the previous theme exposed every affected widget. [jQuery UI advisories](https://github.com/jquery/jquery-ui/security)
- Magnific Popup 1.1.0 was enqueued/initialized, although the supplied demo contained no popup-gallery elements. Its upstream 1.2.0 release fixes unsafe HTML handling; the unused library and initialization are now absent. [Upstream security fix](https://github.com/dimsemenov/Magnific-Popup/releases/tag/1.2.0)
- Bootstrap 5.2.0 is the only remaining bundled JavaScript vendor library. Its version matched **zero advisory ranges in the downloaded Retire.js database**. This is a custom inventory comparison using Retire.js data, not a claim that the Retire.js CLI or a full commercial scanner was run. [Database source](https://github.com/RetireJS/retire.js/blob/master/repository/jsrepository.json)
- Other unused JavaScript helpers, duplicate jQuery, their unused stylesheets and mirrored error documents were removed. Imported page content/assets and Bootstrap booking modals remain.

## Tests

WordPress 6.9.4, PHP 8.3.33, Elementor 4.3.1 in the isolated local QA site. Checked PHP syntax; JavaScript syntax; theme/direct-access guards; source-token patterns; SVG active content; asset/package inventory; frontend routes and unique IDs; Elementor escaping/output bounds; importer capability/CSRF checks; contact malformed inputs/header-injection/size limits; atomic rate limiting; mocked mail success/failure; mocked LocationIQ XSS/distance behavior; WhatsApp encoding; native sticky header/sidebar/preloader behavior. No real contact email or WhatsApp message was sent.

The local PHP test server also needed a workspace temp directory and disabled display_errors to prevent pre-bootstrap notices on larger requests. This adjustment was limited to the QA server process, not the host's global PHP configuration.

## Limits and deployment requirements

No scan proves absence of all vulnerabilities. Browser exploit execution and pixel-level visual regression were unavailable. Third-party GTranslate JavaScript and Google Fonts are external runtime resources, not bundled/pinned code; enabling them retains trust in those providers. LocationIQ uses a public browser token and requires domain restrictions and quota controls. SMTP/live email, provider accounts, server/TLS configuration and other plugins still require deployment checks. Public-form nonces and an IP cooldown reduce abuse but are not botnet/DDoS protection. Keep WordPress and plugins updated. Do not deploy the task's testing/tools folders; install only the theme ZIP.

## Importer update 1.0.2 — 25 September 2026

The revised all-page importer retains POST, nonce and capability checks, including manage_options for reading settings and edit_post for repairing existing pages. Import recovery, preserved content, denied requests and per-page status escaping were regression-tested. The dependency inventory is unchanged.


## Elementor and journal update 1.1.0 — 25 September 2026

Page conversion and backup restore require POST, a page-specific nonce and appropriate edit/manage capabilities. Automatic conversion only upgrades the exact old imported layout or untouched demo shortcode. Other edits are preserved. Form layouts come from an allowlisted local catalog; editable copy is bounded and escaped. FAQ content uses WordPress HTML filtering. Native form identifiers are unique per widget and LocationIQ provider responses remain text-only. New journal templates escape metadata and retain password-protected content. Category queries and Elementor-authored article content were checked in the QA site. Existing dependency versions are unchanged; browser visual/interaction QA remains unavailable.
