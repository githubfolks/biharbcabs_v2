#!/usr/bin/env bash
# ==============================================================================
# Nightly Full Backup Script for BiharCabs on Oracle Cloud (OL9)
#
# Backs up:
#   1. Native PostgreSQL `biharcabs_crm` (updates /var/backups/biharcabs/last_backup.json
#      consumed by CRM /api/system/status backup pill)
#   2. Native PostgreSQL `n8n` (workflows, credentials metadata, run history)
#   3. Docker MariaDB `biharcabs_wp` (WordPress database)
#
# Example root/postgres cron (02:30 IST = 21:00 UTC):
#   0 21 * * * /opt/biharcabs/deploy/oracle/scripts/backup-all.sh >> /var/log/biharcabs-backup.log 2>&1
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"

if [[ -f "${ENV_FILE}" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${ENV_FILE}"
  set +a
fi

BACKUP_ROOT="${BACKUP_STATUS_DIR:-/var/backups/biharcabs}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP_UTC="$(date -u +"%Y%m%dT%H%M%SZ")"

mkdir -p "${BACKUP_ROOT}/n8n" "${BACKUP_ROOT}/wp"
chown postgres:postgres "${BACKUP_ROOT}" "${BACKUP_ROOT}/n8n"
chmod 750 "${BACKUP_ROOT}" "${BACKUP_ROOT}/n8n"
chmod 700 "${BACKUP_ROOT}/wp"

echo "=== [${TIMESTAMP_UTC}] Starting BiharCabs full backup ==="

# 1. Native PostgreSQL: n8n database
echo "--> Backing up native Postgres 'n8n'"
sudo -u postgres env \
  PGDATABASE=n8n \
  BACKUP_DIR="${BACKUP_ROOT}/n8n" \
  BACKUP_RETENTION_DAYS="${RETENTION_DAYS}" \
  BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}" \
  BACKUP_S3_URI="${BACKUP_S3_URI:+${BACKUP_S3_URI%/}/n8n}" \
  bash "${REPO_ROOT}/scripts/backup_pg.sh"

# 2. Native PostgreSQL: biharcabs_crm (writes ${BACKUP_ROOT}/last_backup.json for CRM UI)
echo "--> Backing up native Postgres 'biharcabs_crm'"
sudo -u postgres env \
  PGDATABASE=biharcabs_crm \
  BACKUP_DIR="${BACKUP_ROOT}" \
  BACKUP_RETENTION_DAYS="${RETENTION_DAYS}" \
  BACKUP_PASSPHRASE="${BACKUP_PASSPHRASE:-}" \
  BACKUP_S3_URI="${BACKUP_S3_URI:+${BACKUP_S3_URI%/}/crm}" \
  bash "${REPO_ROOT}/scripts/backup_pg.sh"

# Ensure CRM container (uid 1001) can traverse BACKUP_ROOT and read last_backup.json only (dumps remain 600 postgres:postgres)
chmod 755 "${BACKUP_ROOT}"
chmod 644 "${BACKUP_ROOT}/last_backup.json"

# 3. Docker MariaDB: WordPress database
if docker ps --format '{{.Names}}' | grep -qx 'biharcabs_db'; then
  echo "--> Backing up Docker MariaDB '${WP_DB_NAME:-biharcabs_wp}'"
  WP_DUMP="${BACKUP_ROOT}/wp/${WP_DB_NAME:-biharcabs_wp}_${TIMESTAMP_UTC}.sql.gz"
  docker exec -e MYSQL_PWD="${WP_DB_ROOT_PASSWORD:?Set WP_DB_ROOT_PASSWORD in .env}" biharcabs_db \
    mariadb-dump --single-transaction --routines --triggers -u root "${WP_DB_NAME:-biharcabs_wp}" | gzip -9 > "${WP_DUMP}"
  chmod 600 "${WP_DUMP}"
  find "${BACKUP_ROOT}/wp" -maxdepth 1 -type f -name "*.sql.gz" -mtime "+${RETENTION_DAYS}" -delete
  echo "--> WordPress DB backup written to ${WP_DUMP}"
else
  echo "WARNING: biharcabs_db container is not running; skipped MariaDB backup." >&2
fi

echo "=== [${TIMESTAMP_UTC}] BiharCabs full backup complete ==="
