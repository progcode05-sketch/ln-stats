// Must be first import so console is patched before anything else logs.
import "./log-stream.js";
import { getRecentLogs, subscribeToLogs } from "./log-stream.js";

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response, type NextFunction } from "express";
import { ENV } from "./env.js";
import { CONFIG } from "./config.js";
import { randomToken } from "./crypto.js";
import { buildAuthUrl, completeOAuth } from "./oauth.js";
import {
  upsertUser,
  createSession,
  deleteSession,
  setCredentials,
  hasCredentials,
  clearCredentials,
  listCollections,
  getCollection,
  getLatestReadyCollection,
  getCollectionPosts,
  deleteUserData,
  PostRow
} from "./db.js";
import {
  type AuthedRequest,
  loadUser,
  requireAuth,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  setStateCookie,
  consumeStateCookie
} from "./auth.js";
import { getJob, startJob, subscribe } from "./jobs.js";
import { runCollection } from "./worker.js";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(rootDir, "public");

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: "32kb" }));

// ── Tiny cookie parser (avoids an extra dependency) ────────────────────────
app.use((req: Request, _res: Response, next: NextFunction) => {
  const header = req.headers.cookie;
  req.cookies = {};
  if (header) {
    for (const part of header.split(";")) {
      const idx = part.indexOf("=");
      if (idx > -1) {
        const key = part.slice(0, idx).trim();
        req.cookies[key] = decodeURIComponent(part.slice(idx + 1).trim());
      }
    }
  }
  next();
});

app.use(loadUser);

// ── Health check (Render keep-alive ping target) ───────────────────────────
app.get("/health", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// ── OAuth ──────────────────────────────────────────────────────────────────
app.get("/auth/linkedin", (_req, res) => {
  const state = randomToken(16);
  setStateCookie(res, state);
  res.redirect(buildAuthUrl(state));
});

app.get("/auth/linkedin/callback", async (req: AuthedRequest, res) => {
  const { code, state, error, error_description: errorDescription } = req.query as Record<string, string>;
  const expectedState = consumeStateCookie(req, res);

  if (error) {
    res.redirect(`/?auth_error=${encodeURIComponent(errorDescription || error)}`);
    return;
  }
  if (!code || !state || !expectedState || state !== expectedState) {
    res.redirect("/?auth_error=" + encodeURIComponent("Invalid or expired login attempt. Please try again."));
    return;
  }

  try {
    const profile = await completeOAuth(code);
    upsertUser(profile);
    const token = createSession(profile.sub);
    setSessionCookie(res, token);
    res.redirect("/");
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed.";
    res.redirect(`/?auth_error=${encodeURIComponent(message)}`);
  }
});

app.post("/auth/logout", (req: AuthedRequest, res) => {
  const token = getSessionToken(req);
  if (token) deleteSession(token);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Current user ─────────────────────────────────────────────────────────--
app.get("/api/me", (req: AuthedRequest, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  res.json({
    user: {
      id: req.user.id,
      name: req.user.name,
      email: req.user.email,
      picture: req.user.picture,
      hasCredentials: hasCredentials(req.user.id)
    }
  });
});

// ── LinkedIn credentials (encrypted at rest) ───────────────────────────────
app.post("/api/credentials", requireAuth, (req: AuthedRequest, res) => {
  const { email, password } = (req.body ?? {}) as { email?: string; password?: string };
  if (!email || !password) {
    res.status(400).json({ error: "Both email and password are required." });
    return;
  }
  setCredentials(req.user!.id, email, password);
  res.json({ ok: true });
});

app.delete("/api/credentials", requireAuth, (req: AuthedRequest, res) => {
  clearCredentials(req.user!.id);
  res.json({ ok: true });
});

// ── Start a collection ─────────────────────────────────────────────────────
app.post("/api/collect", requireAuth, (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  if (!hasCredentials(userId)) {
    res.status(400).json({ error: "Connect your LinkedIn account first." });
    return;
  }
  if (!startJob(userId)) {
    res.status(409).json({ error: "A collection is already running." });
    return;
  }
  runCollection(userId).catch((err) => console.error("Collection crashed:", err));
  res.status(202).json({ ok: true });
});

// ── Job state (poll fallback for SSE) ──────────────────────────────────────
app.get("/api/job", requireAuth, (req: AuthedRequest, res) => {
  res.json(getJob(req.user!.id));
});

// ── Server-Sent Events: live collection progress ───────────────────────────
app.get("/api/stream", requireAuth, (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  const send = (state: unknown) => res.write(`data: ${JSON.stringify(state)}\n\n`);
  send(getJob(userId));
  const unsubscribe = subscribe(userId, send);
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
    res.end();
  });
});

// ── Server-Sent Events: live server logs (dev panel) ──────────────────────
app.get("/api/logs", requireAuth, (req: AuthedRequest, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no"
  });
  res.write(": connected\n\n");

  // Send the recent buffer so the panel has history on connect.
  const recent = getRecentLogs();
  for (const entry of recent) {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  }

  const unsub = subscribeToLogs((entry) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": ping\n\n"); }, 20_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unsub();
    res.end();
  });
});

// ── Collections history ────────────────────────────────────────────────────
app.get("/api/collections", requireAuth, (req: AuthedRequest, res) => {
  res.json({ collections: listCollections(req.user!.id) });
});

app.get("/api/collections/latest", requireAuth, (req: AuthedRequest, res) => {
  const latest = getLatestReadyCollection(req.user!.id);
  if (!latest) {
    res.status(404).json({ error: "No collections yet." });
    return;
  }
  res.json(serializeCollection(latest.id, latest.finished_at));
});

app.get("/api/collections/:id", requireAuth, (req: AuthedRequest, res) => {
  const id = Number.parseInt(req.params.id, 10);
  const collection = Number.isFinite(id) ? getCollection(req.user!.id, id) : undefined;
  if (!collection) {
    res.status(404).json({ error: "Collection not found." });
    return;
  }
  res.json(serializeCollection(collection.id, collection.finished_at));
});

// ── Delete account + all data ──────────────────────────────────────────────
app.delete("/api/account", requireAuth, async (req: AuthedRequest, res) => {
  const userId = req.user!.id;
  deleteUserData(userId);
  await fs.rm(path.join(CONFIG.profilesDir, userId), { recursive: true, force: true }).catch(() => undefined);
  clearSessionCookie(res);
  res.json({ ok: true });
});

// ── Static assets ──────────────────────────────────────────────────────────
app.get("/vendor/chart.umd.js", (_req, res) => {
  res.sendFile(path.join(rootDir, "node_modules", "chart.js", "dist", "chart.umd.js"));
});
app.use(express.static(publicDir, { extensions: ["html"] }));

// ── Helpers ────────────────────────────────────────────────────────────────
function serializeCollection(collectionId: number, finishedAt: number | null) {
  const posts = getCollectionPosts(collectionId).map(mapPost);
  return {
    collectionId,
    collectedAt: finishedAt ? new Date(finishedAt).toISOString() : null,
    windowDays: CONFIG.windowDays,
    posts
  };
}

function mapPost(row: PostRow) {
  return {
    postUrl: row.post_url,
    activityUrn: row.activity_urn,
    postedAtText: row.posted_at_text,
    textPreview: row.text_preview,
    status: row.status,
    stats: {
      impressions: row.impressions,
      reactions: row.reactions,
      comments: row.comments,
      reposts: row.reposts
    }
  };
}

// ── Boot ───────────────────────────────────────────────────────────────────
app.listen(ENV.port, () => {
  console.log(`LinkedIn Stats SaaS → ${ENV.baseUrl}`);
  console.log(`Listening on port ${ENV.port} (${ENV.nodeEnv})`);
});
