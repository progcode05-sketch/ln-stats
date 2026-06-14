import type { Request, Response, NextFunction } from "express";
import { ENV } from "./env.js";
import { getSessionUser, UserRow } from "./db.js";

const SESSION_COOKIE = "sid";
const STATE_COOKIE = "oauth_state";

// Express adds parsed cookies via our own tiny parser (below) — keep types loose.
export interface AuthedRequest extends Request {
  user?: UserRow;
}

function cookieOptions(maxAgeMs: number) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: ENV.isProduction,
    path: "/",
    maxAge: maxAgeMs
  };
}

export function setSessionCookie(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, cookieOptions(ENV.sessionTtlDays * 24 * 60 * 60 * 1000));
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(SESSION_COOKIE, { path: "/" });
}

export function getSessionToken(req: Request): string | undefined {
  return req.cookies?.[SESSION_COOKIE];
}

export function setStateCookie(res: Response, state: string): void {
  // Short-lived; only needs to survive the round-trip to LinkedIn.
  res.cookie(STATE_COOKIE, state, cookieOptions(10 * 60 * 1000));
}

export function consumeStateCookie(req: Request, res: Response): string | undefined {
  const state = req.cookies?.[STATE_COOKIE];
  res.clearCookie(STATE_COOKIE, { path: "/" });
  return state;
}

// Attaches req.user when a valid session cookie is present (does not block).
export function loadUser(req: AuthedRequest, _res: Response, next: NextFunction): void {
  const token = getSessionToken(req);
  if (token) req.user = getSessionUser(token);
  next();
}

// Blocks the request with 401 when there is no authenticated user.
export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: "Not authenticated." });
    return;
  }
  next();
}
