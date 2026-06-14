import dotenv from "dotenv";

dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new Error(
      `Missing required environment variable: ${name}. ` +
        `Copy .env.example to .env and fill it in (see README).`
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

const baseUrl = optional("BASE_URL", "http://localhost:4173").replace(/\/+$/, "");

export const ENV = {
  nodeEnv: optional("NODE_ENV", "development"),
  isProduction: optional("NODE_ENV", "development") === "production",
  port: Number.parseInt(optional("PORT", "4173"), 10),

  baseUrl,
  redirectUri: `${baseUrl}/auth/linkedin/callback`,

  linkedinClientId: required("LINKEDIN_CLIENT_ID"),
  linkedinClientSecret: required("LINKEDIN_CLIENT_SECRET"),

  encryptionKey: required("ENCRYPTION_KEY"),
  sessionSecret: required("SESSION_SECRET"),
  sessionTtlDays: Number.parseInt(optional("SESSION_TTL_DAYS", "30"), 10)
} as const;
