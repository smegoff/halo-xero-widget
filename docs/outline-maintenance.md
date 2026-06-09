# Outline Documentation Maintenance

Last reviewed: 2026-06-09

Collection:

- Internal Systems

Parent document:

- Halo Xero Customer Finance TAB
- URL: https://docs.example.com/doc/halo-xero-customer-finance-tab
- ID: `b4ff5afe-9bd0-4625-a9ed-12c76c503718`

## New Document To Publish

Create a new child document under **Halo Xero Customer Finance TAB**:

- Title: `Halo Xero Widget - Admin User Manual`
- Source content: `docs/admin-user-manual/README.md`
- Include the redacted screenshots from:
  `docs/admin-user-manual/screenshots/`

## Existing Documents To Archive Or Mark Superseded

The available Outline MCP connector in this Codex session is read-only, so the
following changes could not be applied directly from Codex. These are the
recommended Outline cleanup actions.

### Archive

- `Halo  Xero Finance Widget (HMAC-only)`
  - ID: `848a9b3d-2b21-470c-a1d1-fad0f3cd59a0`
  - URL: https://docs.example.com/doc/halo-xero-finance-widget-hmac-only
  - Reason: describes old browser OAuth, `tokens.json`, `/auth/connect`, and
    runtime Xero name lookup. Current production uses Xero Custom Connection,
    no `tokens.json`, and Halo-to-Xero resolution through local PostgreSQL.

- `Oneshot Script`
  - ID: `db5a53d0-a694-44dd-b745-e9315206b11e`
  - URL: https://docs.example.com/doc/oneshot-script
  - Reason: contains an old Node bootstrap script that depends on
    `tokens.json`. Current recovery uses `install_halo_xero_widget.sh` and
    Xero Custom Connection credentials.

### Supersede With New Admin Manual

- `Halo ↔ Xero Widget - Admin Console`
  - ID: `d86d5889-fced-465c-999a-88ccc8a646ba`
  - URL: https://docs.example.com/doc/halo-xero-widget-admin-console
  - Reason: stale February 2026 admin guide. Replace with the new admin manual
    content and screenshots.

### Keep But Update Later

- `Halo ↔ Xero Widget - Technical`
  - ID: `991c77cc-dfc8-4599-b033-789a7053ed4d`
  - URL: https://docs.example.com/doc/halo-xero-widget-technical
  - Reason: still useful structurally, but missing Custom Connection,
    GoCardless, cache, export-token, and recovery details.

- `Halo ↔ Xero Widget - Trouble Shooting`
  - ID: `7a5ed71d-0d7a-4fd0-b2b3-61a205b544d4`
  - URL: https://docs.example.com/doc/halo-xero-widget-trouble-shooting
  - Reason: still useful, but mentions cron and OAuth/token recovery paths that
    no longer match production.
