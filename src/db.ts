import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { CONFIG } from "./config.js";
import { ENV } from "./env.js";
import { encryptSecret, decryptSecret, randomToken } from "./crypto.js";
import { CollectedPost } from "./types.js";

fs.mkdirSync(CONFIG.dataDir, { recursive: true });

const db = new DatabaseSync(CONFIG.dbPath);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id                TEXT PRIMARY KEY,         -- LinkedIn OIDC "sub"
    name              TEXT,
    email             TEXT,
    picture           TEXT,
    created_at        INTEGER NOT NULL,
    ln_email_enc      TEXT,
    ln_password_enc   TEXT,
    creds_updated_at  INTEGER
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collections (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    status       TEXT NOT NULL,                 -- running | ready | error
    started_at   INTEGER NOT NULL,
    finished_at  INTEGER,
    error        TEXT,
    window_days  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS posts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    collection_id   INTEGER NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
    post_url        TEXT,
    activity_urn    TEXT,
    posted_at_text  TEXT,
    text_preview    TEXT,
    impressions     INTEGER,
    reactions       INTEGER,
    comments        INTEGER,
    reposts         INTEGER,
    status          TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_collections_user ON collections(user_id, started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_collection ON posts(collection_id);
  CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);
`);

// ─── Types ──────────────────────────────────────────────────────────────────

export interface UserRow {
  id: string;
  name: string | null;
  email: string | null;
  picture: string | null;
  created_at: number;
  ln_email_enc: string | null;
  ln_password_enc: string | null;
  creds_updated_at: number | null;
}

export interface CollectionRow {
  id: number;
  user_id: string;
  status: "running" | "ready" | "error";
  started_at: number;
  finished_at: number | null;
  error: string | null;
  window_days: number;
}

export interface PostRow {
  id: number;
  collection_id: number;
  post_url: string | null;
  activity_urn: string | null;
  posted_at_text: string | null;
  text_preview: string | null;
  impressions: number | null;
  reactions: number | null;
  comments: number | null;
  reposts: number | null;
  status: string | null;
}

// ─── Users ──────────────────────────────────────────────────────────────────

export interface OidcProfile {
  sub: string;
  name?: string;
  email?: string;
  picture?: string;
}

export function upsertUser(profile: OidcProfile): UserRow {
  db.prepare(
    `INSERT INTO users (id, name, email, picture, created_at)
     VALUES (@id, @name, @email, @picture, @now)
     ON CONFLICT(id) DO UPDATE SET
       name = excluded.name,
       email = excluded.email,
       picture = excluded.picture`
  ).run({
    id: profile.sub,
    name: profile.name ?? null,
    email: profile.email ?? null,
    picture: profile.picture ?? null,
    now: Date.now()
  });
  return getUser(profile.sub)!;
}

export function getUser(id: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function setCredentials(userId: string, email: string, password: string): void {
  db.prepare(
    `UPDATE users SET ln_email_enc = ?, ln_password_enc = ?, creds_updated_at = ? WHERE id = ?`
  ).run(encryptSecret(email), encryptSecret(password), Date.now(), userId);
}

export function getCredentials(userId: string): { email: string; password: string } | null {
  const row = getUser(userId);
  if (!row?.ln_email_enc || !row?.ln_password_enc) return null;
  return { email: decryptSecret(row.ln_email_enc), password: decryptSecret(row.ln_password_enc) };
}

export function hasCredentials(userId: string): boolean {
  const row = getUser(userId);
  return Boolean(row?.ln_email_enc && row?.ln_password_enc);
}

export function clearCredentials(userId: string): void {
  db.prepare(
    `UPDATE users SET ln_email_enc = NULL, ln_password_enc = NULL, creds_updated_at = NULL WHERE id = ?`
  ).run(userId);
}

// ─── Sessions ───────────────────────────────────────────────────────────────

export function createSession(userId: string): string {
  const token = randomToken();
  const now = Date.now();
  const expires = now + ENV.sessionTtlDays * 24 * 60 * 60 * 1000;
  db.prepare("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    token,
    userId,
    now,
    expires
  );
  return token;
}

export function getSessionUser(token: string): UserRow | undefined {
  const row = db
    .prepare("SELECT user_id, expires_at FROM sessions WHERE token = ?")
    .get(token) as { user_id: string; expires_at: number } | undefined;
  if (!row) return undefined;
  if (row.expires_at < Date.now()) {
    deleteSession(token);
    return undefined;
  }
  return getUser(row.user_id);
}

export function deleteSession(token: string): void {
  db.prepare("DELETE FROM sessions WHERE token = ?").run(token);
}

// ─── Collections + posts ────────────────────────────────────────────────────

export function createCollection(userId: string): number {
  const info = db
    .prepare("INSERT INTO collections (user_id, status, started_at, window_days) VALUES (?, 'running', ?, ?)")
    .run(userId, Date.now(), CONFIG.windowDays);
  return Number(info.lastInsertRowid);
}

const insertPostStmt = db.prepare(
  `INSERT INTO posts
     (collection_id, post_url, activity_urn, posted_at_text, text_preview, impressions, reactions, comments, reposts, status)
   VALUES
     (@collection_id, @post_url, @activity_urn, @posted_at_text, @text_preview, @impressions, @reactions, @comments, @reposts, @status)`
);

export function savePosts(collectionId: number, posts: CollectedPost[]): void {
  db.exec("BEGIN");
  try {
    for (const p of posts) {
      insertPostStmt.run({
        collection_id: collectionId,
        post_url: p.postUrl ?? null,
        activity_urn: p.activityUrn ?? null,
        posted_at_text: p.postedAtText ?? null,
        text_preview: p.textPreview ?? null,
        impressions: p.stats.impressions,
        reactions: p.stats.reactions,
        comments: p.stats.comments,
        reposts: p.stats.reposts,
        status: p.status
      });
    }
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

export function finishCollection(collectionId: number): void {
  db.prepare("UPDATE collections SET status = 'ready', finished_at = ? WHERE id = ?").run(Date.now(), collectionId);
}

export function failCollection(collectionId: number, error: string): void {
  db.prepare("UPDATE collections SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(
    Date.now(),
    error,
    collectionId
  );
}

export interface CollectionSummary {
  id: number;
  status: string;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  postCount: number;
  totals: { impressions: number; reactions: number; comments: number; reposts: number };
}

export function listCollections(userId: string): CollectionSummary[] {
  const rows = db
    .prepare(
      `SELECT c.id, c.status, c.started_at, c.finished_at, c.error,
              COUNT(p.id) AS post_count,
              COALESCE(SUM(p.impressions), 0) AS impressions,
              COALESCE(SUM(p.reactions), 0)   AS reactions,
              COALESCE(SUM(p.comments), 0)    AS comments,
              COALESCE(SUM(p.reposts), 0)     AS reposts
       FROM collections c
       LEFT JOIN posts p ON p.collection_id = c.id
       WHERE c.user_id = ?
       GROUP BY c.id
       ORDER BY c.started_at DESC`
    )
    .all(userId) as Array<{
    id: number;
    status: string;
    started_at: number;
    finished_at: number | null;
    error: string | null;
    post_count: number;
    impressions: number;
    reactions: number;
    comments: number;
    reposts: number;
  }>;

  return rows.map((r) => ({
    id: r.id,
    status: r.status,
    startedAt: new Date(r.started_at).toISOString(),
    finishedAt: r.finished_at ? new Date(r.finished_at).toISOString() : null,
    error: r.error,
    postCount: r.post_count,
    totals: { impressions: r.impressions, reactions: r.reactions, comments: r.comments, reposts: r.reposts }
  }));
}

export function getCollection(userId: string, collectionId: number): CollectionRow | undefined {
  return db
    .prepare("SELECT * FROM collections WHERE id = ? AND user_id = ?")
    .get(collectionId, userId) as CollectionRow | undefined;
}

export function getLatestReadyCollection(userId: string): CollectionRow | undefined {
  return db
    .prepare("SELECT * FROM collections WHERE user_id = ? AND status = 'ready' ORDER BY finished_at DESC LIMIT 1")
    .get(userId) as CollectionRow | undefined;
}

export function getCollectionPosts(collectionId: number): PostRow[] {
  return db
    .prepare("SELECT * FROM posts WHERE collection_id = ? ORDER BY id ASC")
    .all(collectionId) as unknown as PostRow[];
}

export function deleteUserData(userId: string): void {
  // ON DELETE CASCADE removes sessions, collections, and posts.
  db.prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export default db;
