# Halo Xero Widget

A lightweight Node.js service that exposes Xero invoice and balance data inside HaloPSA.  
This app powers a custom **Client Tab** in Halo, displaying live Xero billing data for each client.

---

## 🚀 Overview

This widget allows Halo technicians (and optionally clients) to view up-to-date Xero invoices, totals, and balances without leaving Halo.  
It connects securely to your Xero API data source and renders results inside Halo via an embedded web view.

**Key Features:**
- Displays live Xero invoices per client.
- Supports Halo JWT and API-key authentication.
- Simple RESTful design for Halo tab embedding.
- Production-ready Node.js + Express backend.
- Easy deployment with Nginx + PM2 on Ubuntu.
