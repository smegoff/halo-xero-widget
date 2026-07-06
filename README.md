# Halo Xero Widget

Node.js services for showing Xero finance data inside a HaloPSA custom tab.

The production app resolves Halo client names to Xero Contact GUIDs through
PostgreSQL, then queries Xero by GUID. Runtime Xero name matching is avoided.

## Services

- `server.js`: Halo finance widget on port `3000`.
- `server-admin.js`: admin portal on port `3001`.
- `lib/xero.js`: Xero Custom Connection auth using `client_credentials`.
- `lib/halo.js`: HaloPSA API auth using `client_credentials`.
- `lib/resolver.js`: exact Halo client name to Xero Contact GUID resolver.
- `scripts/sync-xero-contacts.js`: Xero contact sync into Postgres.
- `scripts/run-xero-drift.js`: stored drift detection scan.

## Operator Documentation

- Admin user manual with redacted screenshots:
  `docs/admin-user-manual/README.md`
- Fresh install / recovery runbook:
  `docs/recovery-runbook.md`
- One-shot install / recovery script:
  `install_halo_xero_widget.sh`

## Xero Auth

This project uses a Xero **Custom Connection**, not browser OAuth.

Required `.env` values:

```env
XERO_CLIENT_ID=
XERO_CLIENT_SECRET=
XERO_SCOPES=accounting.contacts.read accounting.invoices.read
```

`tokens.json` and OAuth callback re-auth are not required for Custom
Connections.

## Halo API

The admin console can validate a direct HaloPSA API application using OAuth2
client credentials. This is the foundation for later writing Direct Debit state
back into Halo custom fields.

Required `.env` values:

```env
HALO_RESOURCE_SERVER_URL=https://halo.example.com/api
HALO_AUTH_SERVER_URL=https://halo.example.com/auth
HALO_TENANT=example-tenant
HALO_CLIENT_ID=
HALO_CLIENT_SECRET=
HALO_SCOPES=all
```

The admin dashboard shows **Halo API Status** and links to `/admin/PSA`, where
the Halo API settings can be edited without a restart. The secret field is
write-only; leaving it blank keeps the current secret. The test requests a
bearer token from `/auth/token` and performs a read-only `GET /Client?count=1`
call.

The `/admin/PSA` page also includes a Direct Debit custom-field sync. It uses
the existing Xero Contact GUID to GoCardless customer mapping, finds the
matching Halo client by `xeroid`, and writes Area custom field
`CFDirectDebitActive` / ID `278` with `Active`, `Not active`, or `Cancelled`.
The scheduled GoCardless auto-map runs the same Halo field sync after it creates
safe missing mappings.

## Finance Caching

The finance tab caches Xero invoice data by Xero Contact GUID. This reduces
repeat API calls when the same Halo custom tab is opened repeatedly.

Relevant `.env` values:

```env
FINANCE_CACHE_TTL_SECONDS=300
EXPORT_TOKEN_TTL_SECONDS=900
RUNTIME_CONFIG_PATH=/opt/halo-xero-widget/data/runtime-config.json
EXPORT_TOKEN_SECRET=
```

Use the in-widget **Refresh** button to bypass the cache and fetch fresh Xero
data. PDF and Excel exports use short-lived signed export tokens tied to the
cached finance payload.

The admin dashboard shows and edits the active finance cache TTL and export
link TTL under **Runtime Configuration**. Admin changes are written to
`RUNTIME_CONFIG_PATH` and are picked up by the widget without a service restart.
The `.env` TTL values remain the defaults used when no admin override exists.

Invoice numbers link to the matching customer-facing Xero online invoice when
Xero provides an `OnlineInvoiceUrl`. These links use `in.xero.com` and open the
same invoice view sent to customers, including any configured payment options.

## GoCardless Direct Debit

The finance tab can show a compact GoCardless Direct Debit summary below the
Xero balance cards. It is anchored by Xero Contact GUID, using
`halo.gocardless_customer_map` to map each Xero contact to a GoCardless customer
ID.

Required `.env` values:

```env
GOCARDLESS_ACCESS_TOKEN=
GOCARDLESS_ENVIRONMENT=live
GOCARDLESS_AUTO_MAP_INTERVAL_SECONDS=21600
GOCARDLESS_WEBHOOK_SECRET=
```

The admin console includes **GoCardless Settings** for testing the live API,
updating the token override, searching Halo/Xero clients and GoCardless
customers, auto-mapping eligible mandates when GoCardless exposes a Xero Contact
GUID or when a GoCardless customer with an active, pending approval, pending
submission, or submitted mandate exactly matches one unambiguous Halo client. If
GoCardless does not expose the GUID and the names differ, the mapper can also
resolve the GoCardless customer email against Xero and use the unique returned
Xero Contact GUID. Manual Xero GUID to GoCardless customer mappings remain
supported. The `.env` token remains the default; an admin-entered token is
stored in the runtime config override file and is used immediately.

GoCardless exceptions are available separately at
`/admin/gocardless/exceptions`, covering failed payments, problem mandates, and
duplicate-looking customer records.

The GoCardless settings page also lists unmapped eligible mandate customers.
Admins can choose a safe Halo/Xero candidate or paste a Xero Contact GUID and
click **Map Now** to create the mapping without relying on automatic guessing.

GoCardless webhooks are received at
`https://widget.engagetech.nz/webhooks/gocardless`. Configure this URL in the
GoCardless dashboard and paste the webhook endpoint secret into **GoCardless
Settings**. Webhook events are stored in Postgres and are preferred over API
fallback state for matching mandate IDs. Unknown or duplicate webhook events are
ignored safely; invalid signatures are rejected.

The admin service also runs the same safe auto-map in the background. By default
it starts 60 seconds after the admin process boots and then repeats every 6
hours. The interval can be changed in **Runtime Configuration** or by setting
`GOCARDLESS_AUTO_MAP_INTERVAL_SECONDS`. The finance tab still performs
opportunistic exact-name and unique-email auto-maps when a client is opened, so
new clients do not have to wait for the next scheduled scan.

When a mapped customer has an active mandate, the finance tab's **Mandate
Active** badge links to the GoCardless mandate in the live or sandbox dashboard.
Mapped in-progress mandates are shown with their GoCardless status, such as
**Mandate pending submission**, and also link to the mandate dashboard. Halo's
`CFDirectDebitActive` custom field is written as `Active` when GoCardless either
returns an individual mandate with status `active` or marks the customer record
with `active_mandates: true`.
Webhook `mandates / active` events are also treated as active. Pending statuses
such as `pending_submission` are shown as pending and are not treated as active
unless GoCardless later sends an `active` event or the public API returns an
active signal.

## Halo Tab URL

```text
https://widget.example.com/finance?area=$AREA&agentId=$LOGGEDINAGENTID&hmac=$HMAC
```

`$AREA` is the reliable Halo client-context value. The widget preserves special
handling for unencoded `&` in Halo client names.

## Admin Security

Admin login uses database-backed users in `halo.admin_user` with bcrypt password
hashes. The first account is seeded from `ADMIN_USERNAME` and `ADMIN_PASSWORD`
only when no admin users exist. Login attempts are written to
`halo.admin_login_audit`.

Relevant `.env` values:

```env
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-initial-bootstrap-password
ADMIN_SESSION_SECRET=replace-with-long-random-session-secret
ADMIN_MAX_FAILED_LOGINS=3
ADMIN_LOCKOUT_MINUTES=15
```

Use `/admin/users` to create additional accounts, reset passwords, unlock
accounts, enable/disable accounts, reset MFA, and review login audits. Use
`/admin/profile` to enroll a TOTP authenticator app for the signed-in account.
Once enabled, login requires password plus a six-digit authenticator code.

## Admin Alerts

Admin alerts can be sent to Microsoft Teams using a Teams incoming webhook or a
Teams Workflow webhook URL. The webhook URL can be configured from
`/admin/alerts` and is stored write-only in the runtime config override file.

Relevant `.env` values:

```env
ALERTS_ENABLED=false
TEAMS_WEBHOOK_URL=
```

Alerts are sent for admin lockouts, failed sync jobs, stale Xero contact sync,
failed GoCardless webhook processing, and PM2 service health issues. Routine
successful jobs do not send alerts.

The service health check is designed for cron:

```cron
*/5 * * * * /opt/halo-xero-widget/scripts/run-service-health-check.sh >> /var/log/halo-xero-service-health.log 2>&1
```

It uses `SERVICE_ALERT_SYNC_STALE_MINUTES` and
`SERVICE_ALERT_COOLDOWN_MINUTES` when present, defaulting to 20 minutes and 60
minutes.

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 restart halo-xero
pm2 restart halo-xero-admin
```
