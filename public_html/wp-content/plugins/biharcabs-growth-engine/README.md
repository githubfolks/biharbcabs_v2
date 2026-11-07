# BiharCabs Growth Engine

Holds the rate card and serves fare quotes to the website and the CRM, so both always use the same prices.

## Set up

1. Activate the plugin. It needs no database tables.
2. Enter prices under **Rate Card** in WordPress admin. Rates start blank.
3. Tick **Show estimates on the website and provide them to the CRM** and save. Until then the endpoint returns `QUOTES_DISABLED` and the site shows no prices.

## Fare rules

The rules live in `includes/class-calculator.php` and are repeated on the Rate Card screen.

- **One way and airport:** `max(distance, minimum km) x rate + driver allowance`
- **Round trip:** `max(distance x 2, minimum km x days) x rate + driver allowance x days`
- **Fixed route fare:** replaces the calculation for that route and vehicle. Round trips use it only for one-day trips.
- **Tolls and parking:** never included. The note shown to customers is editable.
- **Local rentals:** always `NO_TARIFF`, because package pricing is not modelled yet.

Fares are rounded to the whole rupee. The website does not currently ask for a return date, so its round-trip estimates assume a same-day return.

## Quote API

`POST /wp-json/biharcabs/v1/quote` is public by design, and limited to 60 requests per IP per 10 minutes. The response must stay in step with `QuoteResponse` in `crm/src/lib/tariff-bridge.ts`.

Request: `origin_city`, `trip_type` (`oneway`, `roundtrip`, `airport`, `local`) and `pickup_date` (`YYYY-MM-DD`) are required. Optional: `destination_city`, `return_date`, `duration_days`, and `origin_lat`, `origin_lon`, `destination_lat`, `destination_lon`.

A place matches a configured route on the part before its first comma, so `Gaya, Bihar, India` matches `Gaya`. Without a matching route, the distance comes from LocationIQ on the server, using the supplied coordinates. Client-supplied distances are not accepted.

| Code | HTTP | Meaning |
|---|---|---|
| `QUOTES_DISABLED` | 403 | Estimates are switched off |
| `INVALID_REQUEST` | 400 | Missing or invalid fields |
| `RATE_LIMITED` | 429 | Too many requests |
| `NO_TARIFF` | 200 | No price available; fall back to a custom quote |

## Audit

Each save records who changed the card and when, and keeps the previous 20 versions in the `bcge_rate_card_history` option. There is no screen for restoring them yet.

## Tests

From the repository root: `php tests/growth-engine/calculator-test.php`
