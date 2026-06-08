# Halo Xero Widget

Node.js services for showing Xero finance data inside a HaloPSA custom tab.

The production app resolves Halo client names to Xero Contact GUIDs through
PostgreSQL, then queries Xero by GUID. Runtime Xero name matching is avoided.

## Services

- `server.js`: Halo finance widget on port `3000`.
- `server-admin.js`: admin portal on port `3001`.
- `lib/xero.js`: Xero Custom Connection auth using `client_credentials`.
- `lib/resolver.js`: exact Halo client name to Xero Contact GUID resolver.
- `scripts/sync-xero-contacts.js`: Xero contact sync into Postgres.
- `scripts/run-xero-drift.js`: stored drift detection scan.

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

## Finance Caching

The finance tab caches Xero invoice data by Xero Contact GUID. This reduces
repeat API calls when the same Halo custom tab is opened repeatedly.

Relevant `.env` values:

```env
FINANCE_CACHE_TTL_SECONDS=300
EXPORT_TOKEN_TTL_SECONDS=900
EXPORT_TOKEN_SECRET=
```

Use the in-widget **Refresh** button to bypass the cache and fetch fresh Xero
data. PDF and Excel exports use short-lived signed export tokens tied to the
cached finance payload.

The admin dashboard shows the active finance cache TTL, export link TTL and
export token secret source under **Runtime Configuration**. These values are
read from the service environment at startup, so changing `.env` requires a
service restart.

## Halo Tab URL

```text
https://widget.engagetech.nz/finance?area=$AREA&agentId=$LOGGEDINAGENTID&hmac=$HMAC
```

`$AREA` is the reliable Halo client-context value. The widget preserves special
handling for unencoded `&` in Halo client names.

## PM2

```bash
pm2 start ecosystem.config.cjs
pm2 restart halo-xero
pm2 restart halo-xero-admin
```
