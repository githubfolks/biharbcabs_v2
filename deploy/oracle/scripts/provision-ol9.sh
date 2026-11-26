#!/usr/bin/env bash
# ==============================================================================
# Oracle Linux 9 (aarch64) Server Provisioning Script for BiharCabs
# Target: OCI Ampere A1 (2 OCPU, 12 GB RAM, Mumbai)
#
# Installs & configures:
#   - Native PostgreSQL 16 on host OS (NOT in Docker)
#   - Docker Engine + Docker Compose v2 plugin
#   - Nginx + Certbot (Let's Encrypt)
#   - firewalld rules (HTTP, HTTPS, and Docker-to-host Postgres 5432)
#   - SELinux boolean (httpd_can_network_connect=1 for Nginx -> localhost upstreams)
#   - /var/backups/biharcabs directory
#
# Run as root or with sudo:
#   sudo bash deploy/oracle/scripts/provision-ol9.sh
# ==============================================================================
set -euo pipefail

if [[ "$(id -u)" -ne 0 ]]; then
  echo "ERROR: Please run with sudo or as root." >&2
  exit 1
fi

echo "==> [1/7] System update & base utilities"
dnf -y update
dnf -y install oracle-epel-release-el9 dnf-utils git rsync jq tar gzip curl wget policycoreutils-python-utils

echo "==> [2/7] Install Docker CE + Compose v2 plugin"
if ! command -v docker >/dev/null 2>&1; then
  dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
  dnf -y install --allowerasing docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
if id -u opc >/dev/null 2>&1; then
  usermod -aG docker opc
fi

echo "==> [3/7] Install Native PostgreSQL 16 (host OS)"
if ! command -v psql >/dev/null 2>&1; then
  dnf -y module reset postgresql || true
  dnf -y module enable postgresql:16
  dnf -y install postgresql-server postgresql-contrib
fi

PGDATA="/var/lib/pgsql/data"
if [[ ! -f "${PGDATA}/PG_VERSION" ]]; then
  postgresql-setup --initdb
fi

echo "==> [4/7] Configure Native PostgreSQL for Docker bridge access (scram-sha-256)"
PG_CONF="${PGDATA}/postgresql.conf"
PG_HBA="${PGDATA}/pg_hba.conf"

# Listen on all interfaces (firewalld + OCI Security List restrict 5432 to localhost & Docker bridge only)
grep -q "^listen_addresses = '\*'" "${PG_CONF}" || echo "listen_addresses = '*'" >> "${PG_CONF}"
grep -q "^password_encryption = 'scram-sha-256'" "${PG_CONF}" || echo "password_encryption = 'scram-sha-256'" >> "${PG_CONF}"

# Memory tuning for 12 GB RAM host shared with WP + MariaDB + CRM + n8n
grep -q "^shared_buffers = 1GB" "${PG_CONF}" || cat >> "${PG_CONF}" <<'EOF'

# --- BiharCabs OCI Ampere A1 (12 GB RAM) tuning ---
shared_buffers = 1GB
effective_cache_size = 3GB
work_mem = 16MB
maintenance_work_mem = 128MB
max_connections = 100
EOF

# Allow Docker containers (172.16.0.0/12) to authenticate with scram-sha-256 for biharcabs_crm and n8n
if ! grep -q "biharcabs_crm.*172.16.0.0/12" "${PG_HBA}"; then
  cat >> "${PG_HBA}" <<'EOF'

# --- BiharCabs Docker containers (CRM & n8n) ---
host    biharcabs_crm   biharcabs_crm   172.16.0.0/12   scram-sha-256
host    n8n             n8n             172.16.0.0/12   scram-sha-256
EOF
fi

systemctl enable --now postgresql
systemctl restart postgresql

echo "==> [5/7] Install Nginx & Certbot"
dnf -y install nginx certbot python3-certbot-nginx
systemctl enable --now nginx

echo "==> [6/7] Configure SELinux & firewalld"
# Required on Oracle Linux 9 (SELinux Enforcing) so Nginx can proxy_pass to 127.0.0.1:8081 & 127.0.0.1:3001
setsebool -P httpd_can_network_connect 1

if systemctl is-active --quiet firewalld; then
  firewall-cmd --permanent --add-service=http
  firewall-cmd --permanent --add-service=https
  # Allow Docker containers to reach native PostgreSQL on port 5432 (NEVER open 5432 publicly!)
  firewall-cmd --permanent --add-rich-rule='rule family="ipv4" source address="172.16.0.0/12" port protocol="tcp" port="5432" accept'
  firewall-cmd --reload
else
  echo "WARNING: firewalld is not active. Ensure host firewall & OCI Security List block port 5432, 3001, 3307, 5678, 8081 publicly."
fi

echo "==> [7/7] Prepare backup & application directories"
mkdir -p /var/backups/biharcabs /opt/biharcabs
chmod 750 /var/backups/biharcabs
if id -u opc >/dev/null 2>&1; then
  chown -R opc:opc /opt/biharcabs
fi

echo ""
echo "=============================================================================="
echo "Provisioning complete!"
echo "Next steps:"
echo "  1. Log out & back in (so 'opc' picks up docker group membership)."
echo "  2. Verify OCI VCN Security List opens ONLY TCP 80, 443 (and restricted 22)."
echo "  3. Create native Postgres databases 'biharcabs_crm' and 'n8n' (see deployment plan)."
echo "=============================================================================="
