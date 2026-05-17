import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * AES-256-GCM envelope for the SES secret access key.
 *
 * The encryption key is intentionally decoupled from JWT_SECRET — those
 * have different rotation needs and one leak shouldn't compromise both.
 * Resolution order:
 *   1. process.env.ENCRYPTION_KEY (must be >= 32 chars).
 *   2. prisma/.encryption-key file (auto-generated, 0600). Persists
 *      across restarts so existing ciphertext stays decryptable.
 *
 * Output: { iv, ciphertext } — both base64. The auth tag is appended
 * to the ciphertext (last 16 bytes) so we only persist two columns.
 *
 * Failure modes (wrong key, tampered ciphertext, rotated key, etc.)
 * throw — callers should treat that as "secret unrecoverable, ask
 * admin to re-enter" and clear the column.
 */

const SCRYPT_SALT = "argus-ses-v1";
const ALGO = "aes-256-gcm";
const KEY_LEN = 32;
const IV_LEN = 12; // GCM canonical IV length
const TAG_LEN = 16;
const MIN_KEY_CHARS = 32;

const KEY_FILE = path.resolve(
  process.cwd(),
  process.env.ENCRYPTION_KEY_FILE ?? "prisma/.encryption-key"
);

let cachedKey: Buffer | null = null;

function loadOrCreateKeyFile(): string {
  if (fs.existsSync(KEY_FILE)) {
    const raw = fs.readFileSync(KEY_FILE, "utf8").trim();
    if (raw.length < MIN_KEY_CHARS) {
      throw new Error(
        `${KEY_FILE} is too short (got ${raw.length} chars; need >= ${MIN_KEY_CHARS}). ` +
          `Either delete the file (will regenerate; existing SES secrets will need re-entry) ` +
          `or replace with a longer value.`
      );
    }
    return raw;
  }
  // First-run: generate, persist 0600.
  const generated = crypto.randomBytes(48).toString("base64url");
  const dir = path.dirname(KEY_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(KEY_FILE, generated + "\n", { mode: 0o600 });
  fs.chmodSync(KEY_FILE, 0o600);
  // eslint-disable-next-line no-console
  console.log(
    `[encryption] generated new encryption key at ${KEY_FILE} (mode 0600). ` +
      `Back this file up alongside the SQLite database.`
  );
  return generated;
}

function deriveKey(): Buffer {
  if (cachedKey) return cachedKey;
  let material: string;
  if (process.env.ENCRYPTION_KEY) {
    if (process.env.ENCRYPTION_KEY.length < MIN_KEY_CHARS) {
      throw new Error(
        `ENCRYPTION_KEY is too short (got ${process.env.ENCRYPTION_KEY.length} chars; need >= ${MIN_KEY_CHARS}).`
      );
    }
    material = process.env.ENCRYPTION_KEY;
  } else {
    material = loadOrCreateKeyFile();
  }
  cachedKey = crypto.scryptSync(material, SCRYPT_SALT, KEY_LEN);
  return cachedKey;
}

export function encryptSecret(plaintext: string): {
  iv: string;
  ciphertext: string;
} {
  if (typeof plaintext !== "string" || plaintext.length === 0) {
    throw new Error("encryptSecret: plaintext required");
  }
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const bundled = Buffer.concat([enc, tag]);
  return {
    iv: iv.toString("base64"),
    ciphertext: bundled.toString("base64"),
  };
}

export function decryptSecret(iv: string, ciphertext: string): string {
  if (!iv || !ciphertext) {
    throw new Error("decryptSecret: iv and ciphertext required");
  }
  const key = deriveKey();
  const ivBuf = Buffer.from(iv, "base64");
  const bundled = Buffer.from(ciphertext, "base64");
  if (bundled.length < TAG_LEN) {
    throw new Error("decryptSecret: ciphertext truncated");
  }
  const enc = bundled.subarray(0, bundled.length - TAG_LEN);
  const tag = bundled.subarray(bundled.length - TAG_LEN);
  const decipher = crypto.createDecipheriv(ALGO, key, ivBuf);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return plain.toString("utf8");
}
