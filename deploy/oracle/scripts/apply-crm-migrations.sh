#!/usr/bin/env bash
# ==============================================================================
# Apply BiharCabs CRM Migrations (01..48+) + Least-Privilege App Role
# Runs against Native PostgreSQL on the host OS (NOT Docker).
#
# Usage:
#   # Ensure root .env has CRM_DB_PASSWORD set, then run as the DB owner (e.g. postgres):
#   sudo -u postgres env PGDATABASE=biharcabs_crm CRM_DB_PASSWORD="<pw>" \
#     bash deploy/oracle/scripts/apply-crm-migrations.sh
# ==============================================================================
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"
DESIGN_DIR="${REPO_ROOT}/crm-design"
DB_NAME="${PGDATABASE:-biharcabs_crm}"

if [[ ! -d "${DESIGN_DIR}" ]]; then
  echo "ERROR: crm-design directory not found at ${DESIGN_DIR}" >&2
  exit 1
fi

echo "==> Applying CRM migrations to native PostgreSQL database '${DB_NAME}'"

# Check if crm_schema_migrations table already exists
HAS_TRACKER="$(psql -tAc "SELECT to_regclass('public.crm_schema_migrations') IS NOT NULL;" "${DB_NAME}")"

for sql_file in "${DESIGN_DIR}"/[0-9][0-9]_*.sql; do
  base="$(basename "${sql_file}")"
  version="${base%%_*}"

  if [[ "${HAS_TRACKER}" == "t" ]]; then
    already="$(psql -tAc "SELECT 1 FROM crm_schema_migrations WHERE version = '${version}' OR version = '${base%.sql}' LIMIT 1;" "${DB_NAME}" || true)"
    if [[ "${already}" == "1" ]]; then
      echo "  [skip] ${base} (already recorded)"
      continue
    fi
  fi

  echo "  [apply] ${base}"
  psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" -f "${sql_file}"

  # Refresh tracker flag after migration 08 creates crm_schema_migrations
  if [[ "${version}" == "08" ]]; then
    HAS_TRACKER="t"
  fi
done

if [[ -n "${CRM_DB_PASSWORD:-}" ]]; then
  echo "==> Applying least-privilege role 'biharcabs_crm' (crm_app_role.sql)"
  psql -v ON_ERROR_STOP=1 -d "${DB_NAME}" -v pw="${CRM_DB_PASSWORD}" -f "${DESIGN_DIR}/crm_app_role.sql"
else
  echo "WARNING: CRM_DB_PASSWORD not set; skipped crm_app_role.sql."
  echo "Run manually: psql -v ON_ERROR_STOP=1 -d ${DB_NAME} -v pw=\"\$CRM_DB_PASSWORD\" -f crm-design/crm_app_role.sql"
fi

echo "==> Migration summary:"
psql -d "${DB_NAME}" -c "SELECT version, applied_at FROM crm_schema_migrations ORDER BY version;"
