import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const CONFIG = {
  projectRoot,

  // ── Single-user CLI paths (npm run login / collect) ──────────────────────
  userDataDir: path.join(projectRoot, ".local", "linkedin-profile"),
  outputPath: path.join(projectRoot, "output", "linkedin-post-stats.json"),

  // ── Multi-user SaaS paths ────────────────────────────────────────────────
  dataDir: path.join(projectRoot, "data"),
  dbPath: path.join(projectRoot, "data", "app.db"),
  // Per-user persisted browser profiles live under here: profiles/<userId>
  profilesDir: path.join(projectRoot, ".local", "profiles"),

  // ── Collection tuning ────────────────────────────────────────────────────
  windowDays: 30,
  maxScrolls: 40,
  maxPosts: 100,
  navigationTimeoutMs: 60_000,
  settleDelayMs: 2_000
} as const;
