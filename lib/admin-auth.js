import bcrypt from "bcrypt";
import { pgPool } from "./db.js";
import { sendAdminAlert } from "./alerts.js";

const DEFAULT_MAX_FAILED_LOGINS = 3;
const DEFAULT_LOCKOUT_MINUTES = 15;
const BCRYPT_ROUNDS = 12;

let ensurePromise = null;

function positiveIntegerEnv(name, defaultValue) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isFinite(value) && value > 0 ? value : defaultValue;
}

export function getAdminSecurityConfig() {
  return {
    maxFailedLogins: positiveIntegerEnv("ADMIN_MAX_FAILED_LOGINS", DEFAULT_MAX_FAILED_LOGINS),
    lockoutMinutes: positiveIntegerEnv("ADMIN_LOCKOUT_MINUTES", DEFAULT_LOCKOUT_MINUTES)
  };
}

export async function ensureAdminAuthTables() {
  if (!ensurePromise) {
    ensurePromise = (async () => {
      await pgPool.query("CREATE SCHEMA IF NOT EXISTS halo");
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS halo.admin_user (
          id serial PRIMARY KEY,
          username text NOT NULL,
          password_hash text NOT NULL,
          role text NOT NULL DEFAULT 'admin',
          is_active boolean NOT NULL DEFAULT true,
          failed_login_count integer NOT NULL DEFAULT 0,
          locked_until timestamptz,
          last_login_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await pgPool.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS admin_user_username_lower_idx
        ON halo.admin_user (lower(username))
      `);
      await pgPool.query(`
        CREATE TABLE IF NOT EXISTS halo.admin_login_audit (
          id bigserial PRIMARY KEY,
          admin_user_id integer REFERENCES halo.admin_user(id) ON DELETE SET NULL,
          username text,
          success boolean NOT NULL,
          failure_reason text,
          ip_address inet,
          user_agent text,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await seedInitialAdminUser();
    })();
  }

  return ensurePromise;
}

async function seedInitialAdminUser() {
  const existing = await pgPool.query("SELECT 1 FROM halo.admin_user LIMIT 1");
  if (existing.rowCount > 0) return;

  const username = String(process.env.ADMIN_USERNAME || "").trim();
  const password = String(process.env.ADMIN_PASSWORD || "");
  if (!username || !password) {
    throw new Error("No admin users exist and ADMIN_USERNAME/ADMIN_PASSWORD are not configured.");
  }

  const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
  await pgPool.query(
    `
      INSERT INTO halo.admin_user (username, password_hash)
      VALUES ($1, $2)
    `,
    [username, passwordHash]
  );
  console.log("Admin user table seeded from ADMIN_USERNAME.");
}

function normaliseIpAddress(ipAddress) {
  const value = String(ipAddress || "").trim();
  if (!value) return null;
  if (value.startsWith("::ffff:")) return value.slice(7);
  return value;
}

async function recordLoginAudit({ userId = null, username, success, failureReason, ipAddress, userAgent }) {
  await pgPool.query(
    `
      INSERT INTO halo.admin_login_audit (
        admin_user_id,
        username,
        success,
        failure_reason,
        ip_address,
        user_agent
      )
      VALUES ($1, $2, $3, $4, $5::inet, $6)
    `,
    [
      userId,
      String(username || "").trim() || null,
      Boolean(success),
      failureReason || null,
      normaliseIpAddress(ipAddress),
      String(userAgent || "").slice(0, 500) || null
    ]
  );
}

export async function authenticateAdminLogin({ username, password, ipAddress, userAgent }) {
  await ensureAdminAuthTables();

  const usernameInput = String(username || "").trim();
  const passwordInput = String(password || "");
  const genericFailure = {
    ok: false,
    message: "Invalid username or password."
  };

  if (!usernameInput || !passwordInput) {
    await recordLoginAudit({
      username: usernameInput,
      success: false,
      failureReason: "missing_credentials",
      ipAddress,
      userAgent
    });
    return genericFailure;
  }

  const { rows } = await pgPool.query(
    `
      SELECT *
      FROM halo.admin_user
      WHERE lower(username) = lower($1)
      LIMIT 1
    `,
    [usernameInput]
  );
  const user = rows[0];

  if (!user) {
    await recordLoginAudit({
      username: usernameInput,
      success: false,
      failureReason: "unknown_user",
      ipAddress,
      userAgent
    });
    return genericFailure;
  }

  if (!user.is_active) {
    await recordLoginAudit({
      userId: user.id,
      username: user.username,
      success: false,
      failureReason: "inactive_user",
      ipAddress,
      userAgent
    });
    return {
      ok: false,
      message: "This admin account is disabled."
    };
  }

  const lockedUntil = user.locked_until ? new Date(user.locked_until) : null;
  if (lockedUntil && lockedUntil.getTime() > Date.now()) {
    await recordLoginAudit({
      userId: user.id,
      username: user.username,
      success: false,
      failureReason: "locked_out",
      ipAddress,
      userAgent
    });
    return {
      ok: false,
      message: `Too many failed attempts. Try again after ${lockedUntil.toLocaleString("en-NZ")}.`
    };
  }

  const passwordOk = await bcrypt.compare(passwordInput, user.password_hash);
  if (!passwordOk) {
    const securityConfig = getAdminSecurityConfig();
    const failedCount = Number(user.failed_login_count || 0) + 1;
    const shouldLock = failedCount >= securityConfig.maxFailedLogins;
    const lockoutMinutes = shouldLock ? securityConfig.lockoutMinutes : 0;

    await pgPool.query(
      `
        UPDATE halo.admin_user
        SET failed_login_count = $2,
            locked_until = CASE WHEN $3 THEN now() + ($4::text || ' minutes')::interval ELSE locked_until END,
            updated_at = now()
        WHERE id = $1
      `,
      [user.id, failedCount, shouldLock, lockoutMinutes]
    );
    await recordLoginAudit({
      userId: user.id,
      username: user.username,
      success: false,
      failureReason: shouldLock ? "locked_after_failed_password" : "bad_password",
      ipAddress,
      userAgent
    });

    if (shouldLock) {
      sendAdminAlert({
        severity: "error",
        title: "Admin account locked",
        summary: `Admin user ${user.username} was locked after failed login attempts.`,
        facts: [
          { title: "Username", value: user.username },
          { title: "Failed attempts", value: failedCount },
          { title: "Lockout minutes", value: lockoutMinutes },
          { title: "IP address", value: normaliseIpAddress(ipAddress) || "Not captured" }
        ]
      }).catch(err => {
        console.warn("Admin lockout alert failed:", err.response?.status || err.message);
      });
    }

    return shouldLock
      ? {
          ok: false,
          message: `Too many failed attempts. Account locked for ${lockoutMinutes} minutes.`
        }
      : genericFailure;
  }

  await pgPool.query(
    `
      UPDATE halo.admin_user
      SET failed_login_count = 0,
          locked_until = NULL,
          last_login_at = now(),
          updated_at = now()
      WHERE id = $1
    `,
    [user.id]
  );
  await recordLoginAudit({
    userId: user.id,
    username: user.username,
    success: true,
    ipAddress,
    userAgent
  });

  return {
    ok: true,
    user: {
      id: user.id,
      username: user.username,
      role: user.role
    }
  };
}

export async function listAdminUsers() {
  await ensureAdminAuthTables();
  const { rows } = await pgPool.query(`
    SELECT
      id,
      username,
      role,
      is_active,
      failed_login_count,
      locked_until,
      last_login_at,
      created_at,
      updated_at
    FROM halo.admin_user
    ORDER BY lower(username)
  `);

  return rows;
}

export async function listAdminLoginAudits(limit = 100) {
  await ensureAdminAuthTables();
  const { rows } = await pgPool.query(
    `
      SELECT
        id,
        admin_user_id,
        username,
        success,
        failure_reason,
        ip_address::text AS ip_address,
        user_agent,
        created_at
      FROM halo.admin_login_audit
      ORDER BY created_at DESC
      LIMIT $1
    `,
    [limit]
  );

  return rows;
}

function validateUsername(username) {
  const value = String(username || "").trim();
  if (!/^[A-Za-z0-9._@-]{3,80}$/.test(value)) {
    throw new Error("Username must be 3-80 characters and use letters, numbers, dot, underscore, hyphen, or @.");
  }
  return value;
}

function validatePassword(password) {
  const value = String(password || "");
  if (value.length < 14) {
    throw new Error("Password must be at least 14 characters.");
  }
  return value;
}

export async function createAdminUser({ username, password }) {
  await ensureAdminAuthTables();
  const cleanUsername = validateUsername(username);
  const cleanPassword = validatePassword(password);
  const passwordHash = await bcrypt.hash(cleanPassword, BCRYPT_ROUNDS);

  await pgPool.query(
    `
      INSERT INTO halo.admin_user (username, password_hash)
      VALUES ($1, $2)
    `,
    [cleanUsername, passwordHash]
  );
}

export async function updateAdminUserPassword({ userId, password }) {
  await ensureAdminAuthTables();
  const cleanPassword = validatePassword(password);
  const passwordHash = await bcrypt.hash(cleanPassword, BCRYPT_ROUNDS);
  const { rowCount } = await pgPool.query(
    `
      UPDATE halo.admin_user
      SET password_hash = $2,
          failed_login_count = 0,
          locked_until = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [userId, passwordHash]
  );
  if (rowCount !== 1) throw new Error("Admin user was not found.");
}

export async function unlockAdminUser(userId) {
  await ensureAdminAuthTables();
  await pgPool.query(
    `
      UPDATE halo.admin_user
      SET failed_login_count = 0,
          locked_until = NULL,
          updated_at = now()
      WHERE id = $1
    `,
    [userId]
  );
}

export async function setAdminUserActive({ userId, isActive }) {
  await ensureAdminAuthTables();
  await pgPool.query(
    `
      UPDATE halo.admin_user
      SET is_active = $2,
          updated_at = now()
      WHERE id = $1
    `,
    [userId, Boolean(isActive)]
  );
}
