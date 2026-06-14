import crypto from "node:crypto";
import { ENV } from "./env.js";

// AES-256-GCM authenticated encryption for LinkedIn passwords at rest.
// Stored format:  base64(iv) : base64(authTag) : base64(ciphertext)

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12;

function getKey(): Buffer {
  const key = Buffer.from(ENV.encryptionKey, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ENCRYPTION_KEY must decode to exactly 32 bytes (base64). " +
        'Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"'
    );
  }
  return key;
}

export function encryptSecret(plainText: string): string {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plainText, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSecret(payload: string): string {
  const [ivB64, tagB64, dataB64] = payload.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted payload.");
  }
  const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]);
  return plain.toString("utf8");
}

// Random URL-safe token for session cookies.
export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("base64url");
}
