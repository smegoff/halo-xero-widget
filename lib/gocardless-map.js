import { pgPool } from "./db.js";

let ensurePromise = null;

export function ensureGoCardlessMappingTable() {
  if (!ensurePromise) {
    ensurePromise = pgPool.query(`
      CREATE TABLE IF NOT EXISTS halo.gocardless_customer_map (
        xero_contact_guid uuid PRIMARY KEY,
        gocardless_customer_id text NOT NULL,
        halo_client_name text,
        notes text,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT gocardless_customer_id_format
          CHECK (gocardless_customer_id ~ '^CU[0-9A-Z]+$')
      )
    `);
  }

  return ensurePromise;
}

export async function getGoCardlessMappingForXeroGuid(xeroContactGuid) {
  await ensureGoCardlessMappingTable();

  const { rows } = await pgPool.query(
    `
      SELECT xero_contact_guid, gocardless_customer_id, halo_client_name, notes, updated_at
      FROM halo.gocardless_customer_map
      WHERE xero_contact_guid = $1
      LIMIT 1
    `,
    [xeroContactGuid]
  );

  return rows[0] || null;
}

export async function getHaloClientByXeroGuid(xeroContactGuid) {
  await ensureGoCardlessMappingTable();

  const { rows } = await pgPool.query(
    `
      SELECT halo_client_name, xero_contact_number, xero_contact_guid
      FROM halo.halo_client
      WHERE xero_contact_guid = $1
      LIMIT 1
    `,
    [xeroContactGuid]
  );

  return rows[0] || null;
}

export async function listGoCardlessMappings(limit = 250) {
  await ensureGoCardlessMappingTable();

  const { rows } = await pgPool.query(
    `
      SELECT
        m.xero_contact_guid,
        m.gocardless_customer_id,
        COALESCE(h.halo_client_name, m.halo_client_name) AS halo_client_name,
        h.xero_contact_number,
        m.notes,
        m.updated_at
      FROM halo.gocardless_customer_map m
      LEFT JOIN halo.halo_client h ON h.xero_contact_guid = m.xero_contact_guid
      ORDER BY COALESCE(h.halo_client_name, m.halo_client_name), m.xero_contact_guid
      LIMIT $1
    `,
    [limit]
  );

  return rows;
}

export async function searchMappedHaloClients(query, limit = 30) {
  await ensureGoCardlessMappingTable();
  const search = `%${String(query || "").trim()}%`;

  if (!String(query || "").trim()) return [];

  const { rows } = await pgPool.query(
    `
      SELECT halo_client_name, xero_contact_number, xero_contact_guid
      FROM halo.halo_client
      WHERE xero_contact_guid IS NOT NULL
        AND (
          halo_client_name ILIKE $1
          OR xero_contact_number ILIKE $1
          OR xero_contact_guid::text ILIKE $1
        )
      ORDER BY halo_client_name
      LIMIT $2
    `,
    [search, limit]
  );

  return rows;
}

export async function upsertGoCardlessMapping(input) {
  await ensureGoCardlessMappingTable();

  const xeroContactGuid = String(input.xeroContactGuid || "").trim();
  const goCardlessCustomerId = String(input.goCardlessCustomerId || "").trim().toUpperCase();
  const haloClientName = String(input.haloClientName || "").trim() || null;
  const notes = String(input.notes || "").trim() || null;

  if (!/^[0-9a-fA-F-]{36}$/.test(xeroContactGuid)) {
    throw new Error("Xero Contact GUID must be a valid GUID.");
  }

  if (!/^CU[0-9A-Z]+$/.test(goCardlessCustomerId)) {
    throw new Error("GoCardless customer ID must start with CU.");
  }

  await pgPool.query(
    `
      INSERT INTO halo.gocardless_customer_map (
        xero_contact_guid,
        gocardless_customer_id,
        halo_client_name,
        notes,
        updated_at
      )
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (xero_contact_guid)
      DO UPDATE SET
        gocardless_customer_id = EXCLUDED.gocardless_customer_id,
        halo_client_name = EXCLUDED.halo_client_name,
        notes = EXCLUDED.notes,
        updated_at = now()
    `,
    [xeroContactGuid, goCardlessCustomerId, haloClientName, notes]
  );
}

export async function insertAutoGoCardlessMapping(input) {
  await ensureGoCardlessMappingTable();

  const xeroContactGuid = String(input.xeroContactGuid || "").trim();
  const goCardlessCustomerId = String(input.goCardlessCustomerId || "").trim().toUpperCase();
  const haloClientName = String(input.haloClientName || "").trim() || null;
  const notes = String(input.notes || "").trim() || "Auto-mapped from GoCardless";

  if (!/^[0-9a-fA-F-]{36}$/.test(xeroContactGuid)) {
    throw new Error("Xero Contact GUID must be a valid GUID.");
  }

  if (!/^CU[0-9A-Z]+$/.test(goCardlessCustomerId)) {
    throw new Error("GoCardless customer ID must start with CU.");
  }

  const { rowCount } = await pgPool.query(
    `
      INSERT INTO halo.gocardless_customer_map (
        xero_contact_guid,
        gocardless_customer_id,
        halo_client_name,
        notes,
        updated_at
      )
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (xero_contact_guid) DO NOTHING
    `,
    [xeroContactGuid, goCardlessCustomerId, haloClientName, notes]
  );

  return rowCount === 1;
}

export async function deleteGoCardlessMapping(xeroContactGuid) {
  await ensureGoCardlessMappingTable();

  await pgPool.query(
    "DELETE FROM halo.gocardless_customer_map WHERE xero_contact_guid = $1",
    [xeroContactGuid]
  );
}
