# Halo Xero Widget Admin User Manual

Last updated: 2026-06-09

This manual covers the production admin console at:

```text
https://widget.engagetech.nz/admin
```

Screenshots are redacted for documentation. Live customer rows, payment IDs,
logs, and exception details are intentionally hidden.

## 1. Sign In

Open `/admin` and sign in with the admin username and password held in the
server `.env` file.

The admin session cookie is separate from the Halo finance tab and is valid for
the configured session period.

## 2. Dashboard

![Admin dashboard](screenshots/admin-dashboard.png)

The dashboard gives a quick operational view:

- Database connectivity.
- Halo API health.
- Xero Custom Connection health.
- GoCardless API health.
- Last Xero contact sync state.
- Runtime configuration for cache, export links, and GoCardless auto-map.
- Action buttons for sync, full resync, Halo/Xero health checks, logs, drift,
  and GoCardless settings.

### Runtime Configuration

Use **Runtime Configuration** to adjust:

- Finance Cache TTL: how long finance tab data is cached per Xero Contact GUID.
- Export Link TTL: how long generated PDF/Excel links remain valid.
- GoCardless Auto-map Interval: how often the admin service scans active
  GoCardless mandates and creates safe missing mappings.

Changes are written to the runtime config JSON file and are picked up without a
service restart.

### Halo API Check

Use **Halo API** or open `/admin/PSA` to configure and validate the Halo
client-credentials application. The client secret is write-only; leave it blank
to keep the current secret. The page can request a bearer token and perform a
read-only client list call. It does not update Halo records.

## 3. GoCardless Settings

![GoCardless settings](screenshots/admin-gocardless-settings.png)

Use **GoCardless Settings** to:

- Save or clear the GoCardless API token override.
- Test the GoCardless API.
- Run the active mandate auto-map manually.
- Search Halo/Xero clients by name or Xero Contact GUID.
- Search GoCardless customers by name, email, ID, or metadata.
- Add or update a manual Xero Contact GUID to GoCardless customer mapping.
- Open the dedicated GoCardless Exceptions page.

### Automatic Mapping Rules

The auto-map process only creates a mapping when it has a safe match:

- GoCardless exposes a Xero Contact GUID in metadata or related fields.
- The active GoCardless customer name exactly matches one unambiguous Halo
  client with a Xero Contact GUID.
- The GoCardless customer email resolves to exactly one Xero Contact, and that
  Xero Contact GUID exists in Halo.

Existing manual mappings are preserved. A GoCardless customer already mapped to
another Xero GUID is skipped.

## 4. GoCardless Exceptions

![GoCardless exceptions](screenshots/admin-gocardless-exceptions.png)

Open `/admin/gocardless/exceptions` from the GoCardless Settings panel.

This page runs the exception scan on demand and shows:

- Failed or cancelled payments.
- Failed, expired, or cancelled mandates.
- Possible duplicate GoCardless customer records.

Use this page when investigating why a customer does not show **Mandate Active**
in the Halo finance tab or when reconciling Direct Debit issues.

## 5. Logs

![Admin logs](screenshots/admin-logs.png)

Use `/admin/logs` to inspect PM2 and sync logs from the admin console.

Typical checks:

- `halo-xero-error.log` for finance tab runtime errors.
- `halo-xero-admin-error.log` for admin console errors.
- Sync logs for Xero contact sync failures.

Sensitive log contents are redacted in this documentation screenshot.

## 6. App Exceptions

![Admin exceptions](screenshots/admin-exceptions.png)

Use `/admin/exceptions` to inspect stored sync/app exceptions. This is separate
from GoCardless Exceptions and is focused on the widget and Xero sync layer.

## 7. Finance Tab Behaviour

The Halo finance tab is anchored by Xero Contact GUID. It shows:

- Account balance and overdue balance.
- Open invoice rows, with invoice numbers linking to the customer-facing Xero
  online invoice when Xero provides an `OnlineInvoiceUrl`.
- GoCardless Direct Debit status.

The GoCardless status labels are:

- **Mandate Active**: a mapped GoCardless customer has at least one active
  mandate. The badge opens the GoCardless mandate in the dashboard.
- **Mandate Not Active**: a mapped customer exists but no active mandate was
  found.
- **Mandate Unknown**: no GoCardless customer is mapped, GoCardless is not
  configured, or the lookup failed.

Opening the finance tab can also opportunistically create a safe GoCardless
mapping by exact name or unique Xero/GoCardless email match.

## 8. Common Admin Tasks

### Refresh Finance Data

Use the **Refresh** button inside the Halo finance tab. It bypasses the current
cache entry and pulls fresh Xero data.

### Update GoCardless Token

1. Open `/admin/gocardless`.
2. Paste the new live API token into **Live API Token**.
3. Click **Save Token**.
4. Click **Test GoCardless API**.

The token is not displayed after saving.

### Force GoCardless Mapping

1. Open `/admin/gocardless`.
2. Search for the Halo/Xero client.
3. Search for the GoCardless customer.
4. Add the Xero Contact GUID and GoCardless customer ID under **Add or Update
   Mapping**.
5. Save the mapping.

Manual mappings are useful when names or emails do not give a safe automatic
match.

### Run Xero Contact Sync

Use **Run Sync Now** on the dashboard for a normal delta sync.

Use **Full Resync** only when the sync watermark needs to be reset. Full resync
is slower and should be treated as an operational action.

## 9. Recovery

Use the repository script for a fresh install or recovery:

```bash
sudo bash install_halo_xero_widget.sh
```

For a new host, supply a real `.env` file:

```bash
sudo ENV_FILE=/root/halo-xero.env CONFIGURE_NGINX=1 ENABLE_CERTBOT=1 \
  CERTBOT_EMAIL=admin@example.com bash install_halo_xero_widget.sh
```

See `docs/recovery-runbook.md` for the full recovery checklist.
