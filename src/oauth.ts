import { ENV } from "./env.js";
import { OidcProfile } from "./db.js";

const AUTH_URL = "https://www.linkedin.com/oauth/v2/authorization";
const TOKEN_URL = "https://www.linkedin.com/oauth/v2/accessToken";
const USERINFO_URL = "https://api.linkedin.com/v2/userinfo";
const SCOPE = "openid profile email";

// Step 1 — URL we redirect the user to so they authorize the app.
export function buildAuthUrl(state: string): string {
  const params = new URLSearchParams({
    response_type: "code",
    client_id: ENV.linkedinClientId,
    redirect_uri: ENV.redirectUri,
    state,
    scope: SCOPE
  });
  return `${AUTH_URL}?${params.toString()}`;
}

// Step 2 — exchange the authorization code for an access token.
async function exchangeCodeForToken(code: string): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: ENV.redirectUri,
    client_id: ENV.linkedinClientId,
    client_secret: ENV.linkedinClientSecret
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LinkedIn token exchange failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("LinkedIn token response did not contain an access_token.");
  return json.access_token;
}

// Step 3 — use the access token to read the user's basic profile.
async function fetchUserInfo(accessToken: string): Promise<OidcProfile> {
  const res = await fetch(USERINFO_URL, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`LinkedIn userinfo failed (${res.status}): ${detail.slice(0, 300)}`);
  }
  const json = (await res.json()) as { sub?: string; name?: string; email?: string; picture?: string };
  if (!json.sub) throw new Error("LinkedIn userinfo did not contain a subject id.");
  return { sub: json.sub, name: json.name, email: json.email, picture: json.picture };
}

// Convenience: full callback handling — code -> token -> profile.
export async function completeOAuth(code: string): Promise<OidcProfile> {
  const accessToken = await exchangeCodeForToken(code);
  return fetchUserInfo(accessToken);
}
