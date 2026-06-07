# CODEX.md

# Halo ↔ Xero Widget

Authoritative project context and operating guide for future development.

---

# Project Purpose

This project provides a HaloPSA Finance widget that displays customer financial information from Xero inside Halo.

The solution was created because HaloPSA does not reliably expose a Xero Contact GUID to custom tabs.

The widget resolves Halo client names to Xero Contact GUIDs via PostgreSQL and then retrieves finance data directly from Xero.

---

# Architecture

```text
Halo PSA
    |
    | Custom Tab
    |
    v
NGINX Reverse Proxy
    |
    +-- /finance --> server.js (Widget)
    |
    +-- /admin --> server-admin.js (Admin Portal)
                     |
                     v
                PostgreSQL
                     |
                     v
                  Xero API
```

---

# Production Environment

Server Path:

```bash
/opt/halo-xero-widget
```

Main Application:

```bash
/opt/halo-xero-widget/server.js
```

Admin Portal:

```bash
/opt/halo-xero-widget/server-admin.js
```

Views:

```bash
/opt/halo-xero-widget/views
```

Libraries:

```bash
/opt/halo-xero-widget/lib
```

Scripts:

```bash
/opt/halo-xero-widget/scripts
```

Environment:

```bash
/opt/halo-xero-widget/.env
```

---

# Services

## Widget

PM2 Process

```bash
halo-xero
```

Port

```text
3000
```

Main Route

```text
/finance
```

---

## Admin Portal

PM2 Process

```bash
halo-xero-admin
```

Port

```text
3001
```

Routes

```text
/admin
/admin/login
/admin/exceptions
/admin/drift
/admin/health
/admin/sync
```

---

# NGINX

Configuration

```bash
/etc/nginx/sites-available/halo-xero.conf
```

Production URL

```text
https://widget.engagetech.nz
```

Widget

```text
https://widget.engagetech.nz/finance
```

Admin

```text
https://widget.engagetech.nz/admin
```

Proxy Configuration

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
}

location /admin {
    proxy_pass http://127.0.0.1:3001;
}
```

---

# PostgreSQL

Database

```text
halo_xero
```

Schema

```text
halo
```

Connection configured via .env

```env
DB_HOST=
DB_PORT=
DB_NAME=
DB_USER=
DB_PASSWORD=
```

---

# Database Tables

## halo.halo_client

Authoritative Halo → Xero mapping table.

Columns

```text
halo_client_name
xero_contact_guid
created_at
updated_at
```

Purpose

```text
Halo Client Name
        ↓
Xero Contact GUID
        ↓
Xero API Queries
```

The GUID is authoritative.

Never query Xero by name.

---

## halo.sync_state

Stores sync progress.

Used by import and synchronisation processes.

---

## halo.xero_drift

Stores detected name drift.

Columns

```text
halo_client_name
xero_client_name
xero_contact_guid
detected_at
```

Purpose

Tracks where Halo and Xero names no longer match.

---

# Halo Integration

Current Halo Custom Tab URL

```text
https://widget.engagetech.nz/finance?area=$AREA&agentId=$LOGGEDINAGENTID&hmac=$HMAC
```

Important Discovery

Halo variable:

```text
$AREA
```

is the ONLY reliable client-context variable available inside Halo Custom Tabs.

Halo documentation defines:

```text
$AREA = Client Name
```

Variables tested and rejected:

```text
$CLIENTID
$XEROCUSTOMERIDGUID
$XEROACCOUNTID
```

Do not attempt to use them again.

---

# Critical Halo Behaviour

Halo does not URL encode client names correctly.

Example

```text
Leanne & Stu Christensen
```

Can arrive as

```javascript
{
  area: "Leanne ",
  " Stu Christensen": ""
}
```

The widget contains reconstruction logic for broken names.

Do not remove it.

---

# Finance Lookup Flow

Current Design

```text
Halo
    ↓
$AREA
    ↓
Normalise Client Name
    ↓
Resolve GUID from PostgreSQL
    ↓
Query Xero using GUID
    ↓
Render finance.ejs
```

Names are only used to locate the GUID.

All Xero API activity must use GUIDs.

Never perform runtime name matching against Xero.

---

# Resolver Rules

File

```text
lib/resolver.js
```

Requirements

1. Normalise whitespace.
2. Trim names.
3. Normalise Unicode.
4. Exact match only.
5. Never guess.
6. Fail loudly on ambiguity.

Names are not authoritative.

GUIDs are authoritative.

---

# Xero Integration

File

```text
lib/xero.js
```

Responsible for

* OAuth
* Token refresh
* Tenant management

Primary function

```javascript
ensureToken()
```

---

# Xero Rate Limiting

Xero returns:

```text
429 Too Many Requests
```

The project uses:

```javascript
fetchWithRetry()
```

to retry once.

Large Xero scans must remain asynchronous.

---

# Drift Detection

Script

```bash
node scripts/run-xero-drift.js
```

Purpose

1. Load mapped clients.
2. Query live Xero contacts.
3. Compare names.
4. Store differences in halo.xero_drift.

The admin portal only displays stored drift.

It must not perform live Xero lookups.

---

# Admin Portal

Authentication

Configured in:

```env
ADMIN_USER=
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
```

Implementation

* express-session
* login page
* protected routes

---

# PM2 Commands

Restart Widget

```bash
pm2 restart halo-xero
```

Restart Admin

```bash
pm2 restart halo-xero-admin
```

View Logs

```bash
pm2 logs halo-xero
pm2 logs halo-xero-admin
```

---

# Common Failure Modes

## Wrong Customer Financial Data

Cause

Duplicate GUID mappings.

Detection

```sql
SELECT
    xero_contact_guid,
    COUNT(*)
FROM halo.halo_client
GROUP BY xero_contact_guid
HAVING COUNT(*) > 1;
```

Expected Result

```text
0 rows
```

Duplicate GUIDs must be corrected manually.

---

## Invalid or Missing GUID

Cause

Client name does not resolve.

Typical causes

* Trailing spaces
* Drift
* Missing mapping

Check

```sql
SELECT *
FROM halo.halo_client
WHERE halo_client_name ILIKE '%name%';
```

---

## Halo Ampersand Issue

Cause

Halo breaks names containing:

```text
&
```

Server-side reconstruction exists.

Keep it.

---

## Xero Rate Limits

Cause

Too many requests.

Mitigation

* Retry logic
* Caching
* Asynchronous drift scans

---

# Development Priorities

Current roadmap

1. Mapping Management UI
2. Mapping Repair Workflow
3. Sync Diagnostics
4. Duplicate GUID Detection
5. Better Drift Reporting
6. Admin Dashboard Enhancements
7. Data Integrity Checks

---

# Rules for Future Development

1. GUIDs are authoritative.
2. Halo names are lookup hints only.
3. Never query Xero by name.
4. Never auto-correct mappings.
5. Never silently resolve ambiguity.
6. Admin portal handles diagnostics.
7. Widget must remain lightweight.
8. Preserve HMAC validation.
9. Preserve Halo compatibility.
10. Fail loudly rather than guess.

---

# Current Status

Working

* Halo Finance Tab
* Xero Integration
* PostgreSQL Mapping
* PDF Export
* Excel Export
* Admin Login
* Exceptions Page
* Drift Page
* Health Check
* NGINX Reverse Proxy
* PM2 Deployment

Under Development

* Mapping Management
* Sync Tools
* Mapping Repair UI
* Duplicate Detection
* Reporting

---

# Final Principle

Names drift.

GUIDs do not.

Always trust the GUID.
