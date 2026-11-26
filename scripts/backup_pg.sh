#!/usr/bin/env bash
# ==============================================================================
# Native PostgreSQL Automated Backup Script (macOS & Linux VPS host OS)
#
# Connects directly to the native PostgreSQL instance (not Docker).
# Configure via environment variables (no hardcoded credentials):
#   PGDATABASE            (default: biharcabs_crm)
#   PGHOST / PGPORT / PGUSER / PGPASSWORD  (standard libpq env vars)
#   BACKUP_DIR            (default: ./backups/pg)
#   BACKUP_RETENTION_DAYS (default: 14)
#   BACKUP_PASSPHRASE     (optional: if set, encrypts dump with AES-256-CBC PBKDF2)
#   BACKUP_S3_URI         (optional: e.g. s3://my-bucket/biharcabs-pg/ if aws cli is installed)
#
# Example nightly cron (02:30 IST):
#   30 2 * * * PGDATABASE=biharcabs_crm BACKUP_DIR=/var/backups/biharcabs /path/to/scripts/backup_pg.sh >> /var/log/biharcabs_backup.log 2>&1
# ==============================================================================
set -euo pipefail

DB_NAME="${PGDATABASE:-biharcabs_crm}"
BACKUP_DIR="${BACKUP_DIR:-$(pwd)/backups/pg}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
TIMESTAMP_UTC="$(date -u +"%Y%m%dT%H%M%SZ")"
ISO_UTC="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

mkdir -p "${BACKUP_DIR}"
chmod 700 "${BACKUP_DIR}"

RAW_DUMP="${BACKUP_DIR}/${DB_NAME}_${TIMESTAMP_UTC}.dump"
FINAL_FILE="${RAW_DUMP}"
ENCRYPTED="false"

echo "[${ISO_UTC}] Starting pg_dump for database '${DB_NAME}'..."
pg_dump --format=custom --compress=9 --no-owner --file="${RAW_DUMP}" "${DB_NAME}"

if [[ -n "${BACKUP_PASSPHRASE:-}" ]]; then
  FINAL_FILE="${RAW_DUMP}.enc"
  openssl enc -aes-256-cbc -salt -pbkdf2 -iter 100000 \
    -in "${RAW_DUMP}" -out "${FINAL_FILE}" -pass env:BACKUP_PASSPHRASE
  rm -f "${RAW_DUMP}"
  ENCRYPTED="true"
  echo "[${ISO_UTC}] Encrypted backup written to ${FINAL_FILE}"
else
  echo "[${ISO_UTC}] Compressed backup written to ${FINAL_FILE}"
fi

chmod 600 "${FINAL_FILE}"
SIZE_BYTES="$(wc -c < "${FINAL_FILE}" | tr -d '[:space:]')"

# Optional off-site upload (AWS S3 / Cloudflare R2 / S3-compatible)
if [[ -n "${BACKUP_S3_URI:-}" ]]; then
  if command -v aws >/dev/null 2>&1; then
    aws s3 cp "${FINAL_FILE}" "${BACKUP_S3_URI%/}/$(basename "${FINAL_FILE}")"
    echo "[${ISO_UTC}] Uploaded backup to ${BACKUP_S3_URI}"
  else
    echo "[${ISO_UTC}] WARNING: BACKUP_S3_URI is set but 'aws' CLI is not installed; skipping upload." >&2
  fi
fi

# Prune old local backups beyond retention window
find "${BACKUP_DIR}" -maxdepth 1 -type f \( -name "${DB_NAME}_*.dump" -o -name "${DB_NAME}_*.dump.enc" \) -mtime "+${RETENTION_DAYS}" -delete

# Write status metadata consumed by CRM /api/system/status (when CRM_BACKUP_STATUS_FILE points here)
STATUS_FILE="${BACKUP_DIR}/last_backup.json"
cat > "${STATUS_FILE}" <<EOF
{
  "timestamp": "${ISO_UTC}",
  "database": "${DB_NAME}",
  "file": "$(basename "${FINAL_FILE}")",
  "size_bytes": ${SIZE_BYTES},
  "encrypted": ${ENCRYPTED}
}
EOF

echo "[${ISO_UTC}] Backup completed (${SIZE_BYTES} bytes). Metadata updated at ${STATUS_FILE}"
