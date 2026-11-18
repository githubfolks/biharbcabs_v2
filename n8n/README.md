# n8n: scheduler for CRM background jobs

n8n Community Edition (self-hosted, free under the Sustainable Use License for BiharCabs' own
operations) runs the CRM's scheduled jobs. The jobs' logic stays in the CRM; n8n only calls them on
time and keeps a run history.

| Workflow | Schedule | Calls | Does |
|---|---|---|---|
| `crm-frequent-jobs.json` | every 5 minutes | `POST http://crm:3001/api/dispatch/cron` | return-trip windows, SLA escalation, driver wake-up checks, expired-document suspension, unpaid-dues restriction |
| `crm-daily-jobs.json` | daily 09:00 IST | `POST http://crm:3001/api/dispatch/cron/daily` | document-expiry reminders (expiring within 15 days) |

Expiry reminders are daily only: nothing records who was reminded, so the frequent job would
otherwise message the same drivers every 5 minutes.

Neither workflow retries on failure. A failed run shows as an error in n8n's Executions list; the
frequent job runs again 5 minutes later. Retrying the daily job automatically could send reminders twice.

## Security

- Both CRM endpoints require `Authorization: Bearer <CRON_SECRET>`. Without `CRON_SECRET` set in the
  CRM, they refuse every call (503); a wrong or missing secret gets 401.
- n8n holds the secret in an encrypted Header Auth credential named **BiharCabs CRM cron secret**
  (id `bcCrmCronAuth001`). The workflow files reference it by id and contain no secret.
- The n8n editor listens on `127.0.0.1:5678` only. Do not publish it through Nginx or a public port.
  On the VPS, reach it with an SSH tunnel: `ssh -L 5678:127.0.0.1:5678 <vps>`, then open http://localhost:5678.
- Workflows cannot read container environment variables (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`).
- The first person to open the editor creates the owner account. Do that immediately after first start.

## Environment (root `.env`, never in git)

| Variable | Used by | Notes |
|---|---|---|
| `CRON_SECRET` | CRM and the n8n credential | `openssl rand -hex 32`. Must match in both places. |
| `N8N_ENCRYPTION_KEY` | n8n | `openssl rand -hex 32`. Back it up: without it, stored credentials cannot be decrypted. |
| `N8N_DB_PASSWORD` | n8n | Password of the native Postgres role `n8n`. |

`docker compose` refuses to start if `N8N_ENCRYPTION_KEY` or `N8N_DB_PASSWORD` is missing.

## First-time setup (local and VPS)

1. Add the three variables to the root `.env`.
2. Create n8n's database on the host Postgres, in `psql -d postgres`:
   ```sql
   CREATE ROLE n8n LOGIN PASSWORD '<N8N_DB_PASSWORD>';
   CREATE DATABASE n8n OWNER n8n;
   ```
   On the VPS, make sure `pg_hba.conf` lets the Docker network reach Postgres as `n8n` with `scram-sha-256`.
3. Apply `crm-design/10_driver_wakeup_sent.sql` to `biharcabs_crm` (safe to re-run).
4. Rebuild and start: `docker compose up -d --build crm n8n`.
5. Open the editor and create the owner account.
6. Create the credential: **Credentials → New → Header Auth**, name `BiharCabs CRM cron secret`,
   Name `Authorization`, Value `Bearer <CRON_SECRET>`.
   Or import it with the CLI from a temporary file, then delete the file:
   ```json
   [{"id":"bcCrmCronAuth001","name":"BiharCabs CRM cron secret","type":"httpHeaderAuth",
     "data":{"name":"Authorization","value":"Bearer <CRON_SECRET>"}}]
   ```
   `docker cp cred.json biharcabs_n8n:/tmp/ && docker exec biharcabs_n8n n8n import:credentials --input=/tmp/cred.json && docker exec -u root biharcabs_n8n rm /tmp/cred.json && rm cred.json`
   If created in the UI, open each workflow's HTTP node and select the credential.
7. Import and publish the workflows:
   ```bash
   for f in n8n/workflows/*.json; do docker cp "$f" biharcabs_n8n:/tmp/; docker exec biharcabs_n8n n8n import:workflow --input=/tmp/$(basename "$f"); done
   docker exec -e N8N_RUNNERS_BROKER_PORT=5690 biharcabs_n8n n8n publish:workflow --id=bcCronFrequent01
   docker exec -e N8N_RUNNERS_BROKER_PORT=5690 biharcabs_n8n n8n publish:workflow --id=bcCronDaily00001
   ```
   (`N8N_RUNNERS_BROKER_PORT` keeps the one-off CLI process off the running server's port 5679.)
8. Check **Executions** after the next 5-minute mark: each run should be green and its response
   `success: true`.

If anything else (a system crontab, an uptime pinger) calls `/api/dispatch/cron`, remove it: it now
needs the secret, and two schedulers would run the jobs twice.

## Changing a workflow

Edit in the editor, then export and commit so git stays the source of truth:
```bash
docker exec biharcabs_n8n n8n export:workflow --id=bcCronFrequent01 --pretty --output=/tmp/wf.json && docker cp biharcabs_n8n:/tmp/wf.json n8n/workflows/crm-frequent-jobs.json
```

## Upgrading

The image is pinned (`n8nio/n8n:2.47.4`). To upgrade, change the tag in `docker-compose.yml`, read
n8n's release notes for breaking changes, back up the `n8n` database, and `docker compose up -d n8n`.

## Backups

n8n's workflows, credentials and run history are in the native Postgres database `n8n`; include it
in Postgres backups together with `N8N_ENCRYPTION_KEY`.
