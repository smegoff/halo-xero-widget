import crypto from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const DEFAULT_PERIOD_SECONDS = 30;
const DEFAULT_DIGITS = 6;

export function generateTotpSecret(byteLength = 20) {
  const bytes = crypto.randomBytes(byteLength);
  let bits = "";
  for (const byte of bytes) {
    bits += byte.toString(2).padStart(8, "0");
  }

  let secret = "";
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5).padEnd(5, "0");
    secret += BASE32_ALPHABET[Number.parseInt(chunk, 2)];
  }

  return secret;
}

export function normaliseTotpCode(code) {
  return String(code || "").replace(/\s+/g, "");
}

export function buildOtpAuthUrl({ issuer, accountName, secret }) {
  const safeIssuer = encodeURIComponent(issuer);
  const safeAccount = encodeURIComponent(accountName);
  return `otpauth://totp/${safeIssuer}:${safeAccount}?secret=${secret}&issuer=${safeIssuer}&algorithm=SHA1&digits=${DEFAULT_DIGITS}&period=${DEFAULT_PERIOD_SECONDS}`;
}

function decodeBase32(secret) {
  const clean = String(secret || "").toUpperCase().replace(/=+$/g, "").replace(/\s+/g, "");
  let bits = "";
  for (const char of clean) {
    const value = BASE32_ALPHABET.indexOf(char);
    if (value === -1) throw new Error("Invalid TOTP secret.");
    bits += value.toString(2).padStart(5, "0");
  }

  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) {
    bytes.push(Number.parseInt(bits.slice(i, i + 8), 2));
  }
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = decodeBase32(secret);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac("sha1", key).update(counterBuffer).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DEFAULT_DIGITS).padStart(DEFAULT_DIGITS, "0");
}

export function verifyTotpCode({ secret, code, window = 1, lastUsedStep = null, now = Date.now() }) {
  const cleanCode = normaliseTotpCode(code);
  if (!/^\d{6}$/.test(cleanCode)) {
    return { ok: false, reason: "invalid_format" };
  }

  const currentStep = Math.floor(now / 1000 / DEFAULT_PERIOD_SECONDS);
  const lastStep = lastUsedStep === null || typeof lastUsedStep === "undefined"
    ? null
    : Number(lastUsedStep);

  for (let offset = -window; offset <= window; offset += 1) {
    const step = currentStep + offset;
    if (step < 0) continue;
    if (lastStep !== null && Number.isFinite(lastStep) && step <= lastStep) {
      continue;
    }
    if (hotp(secret, step) === cleanCode) {
      return { ok: true, step };
    }
  }

  return { ok: false, reason: "code_mismatch" };
}
