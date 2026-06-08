// lib/resolver.js
// -------------------------------------------------
// Resolve Xero Contact GUID from Halo Client Name
// - Normalises Halo input
// - Requires EXACT match after normalisation
// - FAILS on ambiguity (never guesses)
// -------------------------------------------------

import { pgPool } from "./db.js";

export async function resolveXeroContactGuid(rawHaloName) {
  if (!rawHaloName) {
    console.warn("⚠️ resolveXeroContactGuid called with empty name");
    return null;
  }

  // -------------------------------------------------
  // NORMALISE HALO INPUT
  // -------------------------------------------------
  const haloClientName = rawHaloName
    .replace(/\u00A0/g, " ")   // NBSP → space
    .replace(/\s+/g, " ")      // collapse whitespace
    .trim()
    .normalize("NFKC");

  console.log(
    "🔁 Resolving Xero GUID for:",
    `"${haloClientName}"`
  );

  // -------------------------------------------------
  // LOOKUP — EXACT MATCH ONLY
  // -------------------------------------------------
  const { rows } = await pgPool.query(
    `
    SELECT
      halo_client_name,
      xero_contact_guid
    FROM halo.halo_client
    WHERE TRIM(halo_client_name) = $1
    `,
    [haloClientName]
  );

  // -------------------------------------------------
  // NO MATCH
  // -------------------------------------------------
  if (rows.length === 0) {
    console.warn("⚠️ No Xero mapping found for:", haloClientName);
    return null;
  }

  // -------------------------------------------------
  // MULTIPLE MATCHES (DATA CORRUPTION / LEGACY)
  // -------------------------------------------------
  if (rows.length > 1) {
    console.error(
      "🚨 Ambiguous Halo client mapping detected for:",
      haloClientName
    );
    console.error(
      "🚨 Matching rows:",
      rows.map(r => r.halo_client_name)
    );

    // DO NOT GUESS — force admin cleanup
    return null;
  }

  // -------------------------------------------------
  // SUCCESS
  // -------------------------------------------------
  const guid = rows[0].xero_contact_guid;

  console.log("✅ Xero GUID resolved:", guid);
  return guid;
}
