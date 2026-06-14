import puppeteer, { Browser, Page } from "puppeteer";
import { CONFIG } from "./config.js";
import { isLikelyLoginUrl, sleep } from "./utils.js";

const REALISTIC_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

export interface LaunchOptions {
  headless: boolean;
  userDataDir: string;
}

// Generic launcher used by both the CLI (visible) and the SaaS worker (headless).
export async function launchBrowser(opts: LaunchOptions): Promise<Browser> {
  const LAUNCH_TIMEOUT_MS = 60_000;

  const launchPromise = puppeteer.launch({
    headless: opts.headless,
    userDataDir: opts.userDataDir,
    defaultViewport: opts.headless ? { width: 1280, height: 900 } : null,
    // These flags are required on Render (Linux, 512 MB, no GPU, no /dev/shm).
    args: opts.headless
      ? [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",   // use /tmp instead of /dev/shm
          "--disable-gpu",
          "--disable-software-rasterizer",
          "--disable-extensions",
          "--disable-background-networking",
          "--disable-default-apps",
          "--no-first-run",
          "--no-zygote",               // skips the zygote process, saves ~50 MB
          "--mute-audio",
          "--window-size=1280,900"
        ]
      : ["--start-maximized"]
  });

  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(
      () =>
        reject(
          new Error(
            `Browser failed to start within ${LAUNCH_TIMEOUT_MS / 1000}s. ` +
              "This usually means the server ran out of memory (Render free tier is 512 MB). " +
              "Wait 30 seconds and try again. If it keeps happening, upgrade the Render instance."
          )
        ),
      LAUNCH_TIMEOUT_MS
    )
  );

  return Promise.race([launchPromise, timeoutPromise]);
}

// ── CLI entry point (visible browser, shared profile) ──────────────────────
export async function launchLinkedInBrowser(): Promise<Browser> {
  return launchBrowser({ headless: false, userDataDir: CONFIG.userDataDir });
}

export async function newLinkedInPage(browser: Browser): Promise<Page> {
  const page = await browser.newPage();
  await page.setUserAgent(REALISTIC_UA);
  page.setDefaultNavigationTimeout(CONFIG.navigationTimeoutMs);
  page.setDefaultTimeout(CONFIG.navigationTimeoutMs);
  return page;
}

// ── Shared "are we logged in?" check ───────────────────────────────────────
async function isLoggedIn(page: Page): Promise<boolean> {
  const onLogin =
    isLikelyLoginUrl(page.url()) ||
    Boolean(await page.$("input[name='session_key'], input#username, input#password").catch(() => null));
  if (onLogin) return false;
  const shell = await page
    .$("main, [data-test-global-nav-link='me'], .global-nav__me, .feed-identity-module")
    .catch(() => null);
  return Boolean(shell);
}

// ── CLI flow: wait for the human to sign in in the visible window ──────────
export async function ensureLoggedIn(page: Page, onLoginRequired?: () => void): Promise<void> {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await sleep(CONFIG.settleDelayMs);

  if (isLikelyLoginUrl(page.url()) || (await page.$("input[name='session_key'], input#username"))) {
    console.log("LinkedIn login is required. Complete login in the opened browser window.");
    console.log("After the feed loads, return here. The agent will continue automatically.");
    onLoginRequired?.();
  }

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    await sleep(1_500);
    if (await isLoggedIn(page)) return;
  }

  throw new Error("Timed out waiting for LinkedIn login. Run npm run login again and complete sign-in.");
}

// ── SaaS flow: headless login using stored credentials ─────────────────────

export class LinkedInChallengeError extends Error {}
export class LinkedInCredentialError extends Error {}

async function loginWithCredentials(page: Page, email: string, password: string): Promise<void> {
  await page.goto("https://www.linkedin.com/login", { waitUntil: "domcontentloaded" });
  await sleep(CONFIG.settleDelayMs);

  await page.waitForSelector("#username", { timeout: 15_000 }).catch(() => undefined);
  const hasForm = await page.$("#username");
  if (!hasForm) {
    // Already authenticated from the persisted profile.
    if (await isLoggedIn(page)) return;
    throw new LinkedInCredentialError("Could not find the LinkedIn login form.");
  }

  await page.type("#username", email, { delay: 40 });
  await page.type("#password", password, { delay: 40 });

  await Promise.all([
    page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => undefined),
    page.click("button[type='submit']")
  ]);
  await sleep(CONFIG.settleDelayMs);

  const url = page.url();

  // LinkedIn threw a security challenge / CAPTCHA / verification step.
  if (/checkpoint|challenge|captcha|add-phone|two-step|verify/i.test(url)) {
    throw new LinkedInChallengeError(
      "LinkedIn asked for an extra security check (CAPTCHA or verification code) that can't be completed " +
        "automatically from the server. This usually happens on the first login or from a new location. " +
        "Wait a few minutes and try again, or sign in to LinkedIn once from your normal device first."
    );
  }

  // Wrong email/password — LinkedIn keeps us on the login page with an error.
  if (await page.$("#error-for-password, .form__label--error, .alert--error")) {
    throw new LinkedInCredentialError("LinkedIn rejected the email or password you provided.");
  }
}

// Ensures the (headless) page is logged in as the user; logs in if needed.
export async function ensureServerLoggedIn(
  page: Page,
  creds: { email: string; password: string },
  onConnecting?: () => void
): Promise<void> {
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await sleep(CONFIG.settleDelayMs);
  if (await isLoggedIn(page)) return;

  onConnecting?.();
  await loginWithCredentials(page, creds.email, creds.password);

  // Confirm the session really took hold.
  await page.goto("https://www.linkedin.com/feed/", { waitUntil: "domcontentloaded" });
  await sleep(CONFIG.settleDelayMs);
  if (!(await isLoggedIn(page))) {
    throw new LinkedInCredentialError(
      "Signed in but LinkedIn did not load your feed. The credentials may be incorrect or the account is restricted."
    );
  }
}
