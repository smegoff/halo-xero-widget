# Halo Xero Widget Recovery Runbook

Last updated: 2026-06-09

This runbook covers a fresh install or recovery of the Halo Xero Widget on an
Ubuntu host.

## Production Defaults

- App directory: `/opt/halo-xero-widget`
- App user: `engageadmin`
- Public host: `widget.example.com`
- Widget service: `halo-xero` on port `3000`
- Admin service: `halo-xero-admin` on port `3001`
- Process manager: PM2
- Reverse proxy: nginx
- Runtime config: `/opt/halo-xero-widget/data/runtime-config.json`

## Required Secrets

Prepare an `.env` file before recovery. Do not commit this file.

Required values:

- PostgreSQL connection: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`,
  `DB_PASSWORD`, `DB_SSL`
- Halo iframe secret: `HMAC_SECRET`
- Halo API: `HALO_RESOURCE_SERVER_URL`, `HALO_AUTH_SERVER_URL`,
  `HALO_TENANT`, `HALO_CLIENT_ID`, `HALO_CLIENT_SECRET`, `HALO_SCOPES`
- Xero Custom Connection: `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET`,
  `XERO_SCOPES`
- Export signing: `EXPORT_TOKEN_SECRET`
- GoCardless: `GOCARDLESS_ACCESS_TOKEN`, `GOCARDLESS_ENVIRONMENT`
- Admin bootstrap/security: `ADMIN_USERNAME`, `ADMIN_PASSWORD`,
  `ADMIN_SESSION_SECRET`, `ADMIN_MAX_FAILED_LOGINS`, `ADMIN_LOCKOUT_MINUTES`
- Alerts: `ALERTS_ENABLED`, `TEAMS_WEBHOOK_URL`

## Fresh Install

```bash
sudo ENV_FILE=/root/halo-xero.env \
  CONFIGURE_NGINX=1 \
  ENABLE_CERTBOT=1 \
  CERTBOT_EMAIL=admin@example.com \
  bash install_halo_xero_widget.sh
```

The script will:

- Install OS runtime dependencies, Node.js, nginx, and PM2.
- Clone `smegoff/halo-xero-widget`.
- Copy the supplied `.env`.
- Install Node dependencies.
- Run `npm run check`.
- Configure nginx if requested.
- Request a Let's Encrypt certificate if requested.
- Start both PM2 services.

## Recovery Over Existing Install

```bash
sudo bash install_halo_xero_widget.sh
```

The script backs up the existing install to:

```text
/opt/halo-xero-widget-backups/<timestamp>/halo-xero-widget.tar.gz
```

It preserves:

- `.env`
- `data/`

Then it resets the code to `origin/main`, reinstalls dependencies, runs syntax
checks, and restarts PM2.

## Optional Initial Sync

To run a Xero contact sync after install:

```bash
sudo RUN_SYNC=1 bash install_halo_xero_widget.sh
```

## Post-Recovery Checks

```bash
cd /opt/halo-xero-widget
sudo -u engageadmin npm run check
sudo -u engageadmin pm2 status
curl -I https://widget.example.com/
curl -I https://widget.example.com/admin
```

Expected:

- `npm run check` exits cleanly.
- `halo-xero` and `halo-xero-admin` are online.
- `/` returns `200`.
- `/admin` redirects unauthenticated users to login.
- The admin dashboard **Halo API Status** is `API OK` after sign-in.

## Cron Jobs

The production host should run the Xero contact sync and service health check
as the app user:

```cron
*/5 * * * * /opt/halo-xero-widget/scripts/run-sync-xero-contacts.sh >> /var/log/halo-xero-sync.log 2>&1
*/5 * * * * /opt/halo-xero-widget/scripts/run-service-health-check.sh >> /var/log/halo-xero-service-health.log 2>&1
```

The service health check sends Teams alerts when PM2 services are not online,
the Xero contact sync is stale, recent GoCardless webhook processing has
failed, or Direct Debit mapping exceptions exist. DD exceptions include
unmapped active/in-progress GoCardless mandate customers, duplicate mappings,
mappings that no longer resolve to a Halo/Xero client, and GoCardless records
that expose a different Xero GUID from the stored mapping.

Repeated identical alerts are suppressed by `SERVICE_ALERT_COOLDOWN_MINUTES`
and stale sync detection defaults to `SERVICE_ALERT_SYNC_STALE_MINUTES=20`.
The DD exception scan is throttled separately with
`DD_ALERT_SCAN_INTERVAL_MINUTES`, defaulting to 60 minutes.

## Rollback

1. Stop PM2 services:

```bash
sudo -u engageadmin pm2 stop halo-xero halo-xero-admin
```

2. Restore a backup:

```bash
cd /opt
sudo mv halo-xero-widget halo-xero-widget.failed.$(date +%Y%m%d-%H%M%S)
sudo tar -xzf /opt/halo-xero-widget-backups/<timestamp>/halo-xero-widget.tar.gz
sudo chown -R engageadmin:engageadmin /opt/halo-xero-widget
```

3. Restart:

```bash
cd /opt/halo-xero-widget
sudo -u engageadmin pm2 start ecosystem.config.cjs
sudo -u engageadmin pm2 save
```

## Notes

- The script does not create the PostgreSQL database. Provision or restore the
  database separately before running an initial sync.
- Xero uses a Custom Connection. `tokens.json` and OAuth re-auth are not part of
  recovery.
- GoCardless mapping data is stored in PostgreSQL, not in the repo.
- Admin users and login audit rows are stored in PostgreSQL. The `.env`
  `ADMIN_USERNAME` and `ADMIN_PASSWORD` values only seed the first account when
  no admin users exist.
- Admin MFA secrets are stored in PostgreSQL on each admin user row. Reset MFA
  from `/admin/users` if an admin loses their authenticator device.
