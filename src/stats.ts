import { Page } from "puppeteer";
import { CONFIG } from "./config.js";
import { CollectedPost, DiscoveredPost, PostStats } from "./types.js";
import { normalizeWhitespace, parseLinkedInCount, sleep } from "./utils.js";

const EMPTY_STATS: PostStats = {
  impressions: null,
  reactions: null,
  comments: null,
  reposts: null
};

export async function collectPostStats(page: Page, post: DiscoveredPost): Promise<CollectedPost> {
  try {
    const { seedStats: _seedStats, ...publicPost } = post;
    let stats: PostStats = { ...EMPTY_STATS, ...post.seedStats };

    if (Object.values(stats).some((value) => value === null)) {
      await page.goto(post.postUrl, { waitUntil: "domcontentloaded" });
      await sleep(CONFIG.settleDelayMs);

      const visibleStats = await extractVisibleStats(page);
      stats = mergeStats(stats, visibleStats);
    }

    if (stats.impressions === null && post.analyticsUrl) {
      const analyticsStats = await extractAnalyticsPageStats(page, post.analyticsUrl);
      stats = mergeStats(stats, analyticsStats);
    } else if (stats.impressions === null) {
      const impressions = await tryExtractImpressions(page);
      stats = { ...stats, impressions: impressions ?? stats.impressions };
    }

    const status = Object.values(stats).every((value) => value !== null) ? "ok" : "partial";

    return {
      ...publicPost,
      stats,
      status
    };
  } catch (error) {
    const { seedStats: _seedStats, ...publicPost } = post;
    return {
      ...publicPost,
      stats: { ...EMPTY_STATS },
      status: "failed",
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function mergeStats(primary: PostStats, fallback: Partial<PostStats>): PostStats {
  return {
    impressions: primary.impressions ?? fallback.impressions ?? null,
    reactions: primary.reactions ?? fallback.reactions ?? null,
    comments: primary.comments ?? fallback.comments ?? null,
    reposts: primary.reposts ?? fallback.reposts ?? null
  };
}

async function extractVisibleStats(page: Page): Promise<PostStats> {
  const candidates = await page.evaluate(() => {
    const scope = document.querySelector("[role='article'][data-urn], .feed-shared-update-v2[data-urn]") || document.body;
    const elements = Array.from(scope.querySelectorAll("button, a, span, div"));
    return elements
      .map((element) => {
        const text = element.textContent || "";
        const aria = element.getAttribute("aria-label") || "";
        return `${aria} ${text}`.replace(/\s+/g, " ").trim();
      })
      .filter(Boolean)
      .slice(0, 2_000);
  });

  const joined = candidates.join(" | ");
  return {
    impressions: findMetric(joined, ["impression", "view"]),
    reactions: findCountBeforeLabel(joined, ["reaction", "like", "support", "insightful", "celebrate", "love"]) ?? zeroWhenOnlyActionExists(joined, "Like"),
    comments: findCountBeforeLabel(joined, ["comment"]) ?? zeroWhenOnlyActionExists(joined, "Comment"),
    reposts: findCountBeforeLabel(joined, ["repost", "share"]) ?? zeroWhenOnlyActionExists(joined, "Repost")
  };
}

async function extractAnalyticsPageStats(page: Page, analyticsUrl: string): Promise<Partial<PostStats>> {
  await page.goto(analyticsUrl, { waitUntil: "domcontentloaded" });
  await sleep(CONFIG.settleDelayMs);
  const text = await page.evaluate(() => document.body.textContent || "");
  const normalized = normalizeWhitespace(text) || "";
  return {
    impressions: findMetric(normalized, ["impression", "view"]),
    reactions: findCountBeforeLabel(normalized, ["reaction", "like", "support", "insightful", "celebrate", "love"]),
    comments: findCountBeforeLabel(normalized, ["comment"]),
    reposts: findCountBeforeLabel(normalized, ["repost", "share"])
  };
}

async function tryExtractImpressions(page: Page): Promise<number | null> {
  const clicked = await clickLikelyAnalyticsControl(page);
  if (!clicked) return null;

  await sleep(2_000);
  const text = await page.evaluate(() => document.body.textContent || "");
  const normalized = normalizeWhitespace(text);
  const impressions = findMetric(normalized || "", ["impression", "view"]);

  await page.keyboard.press("Escape").catch(() => undefined);
  return impressions;
}

async function clickLikelyAnalyticsControl(page: Page): Promise<boolean> {
  const controls = await page.$$("button, a");
  for (const control of controls) {
    const label = await control.evaluate((element) => {
      const text = element.textContent || "";
      const aria = element.getAttribute("aria-label") || "";
      return `${aria} ${text}`.replace(/\s+/g, " ").trim().toLowerCase();
    });

    if (/(analytics|impressions|views|view analytics|show stats|post performance)/i.test(label)) {
      await control.click().catch(() => undefined);
      return true;
    }
  }
  return false;
}

function findMetric(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const beforePattern = new RegExp(`(\\d+(?:[,.]\\d+)*(?:\\.\\d+)?\\s*[kmb]?)\\s+(?:\\w+\\s+){0,3}${label}s?`, "i");
    const beforeMatch = text.match(beforePattern);
    const beforeValue = parseLinkedInCount(beforeMatch?.[1]);
    if (beforeValue !== null) return beforeValue;

    const afterPattern = new RegExp(`${label}s?\\s+(?:\\w+\\s+){0,3}(\\d+(?:[,.]\\d+)*(?:\\.\\d+)?\\s*[kmb]?)`, "i");
    const afterMatch = text.match(afterPattern);
    const afterValue = parseLinkedInCount(afterMatch?.[1]);
    if (afterValue !== null) return afterValue;
  }
  return null;
}

function findCountBeforeLabel(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const pattern = new RegExp(`(\\d+(?:[,.]\\d+)*(?:\\.\\d+)?\\s*[kmb]?)\\s+${label}s?`, "i");
    const value = parseLinkedInCount(text.match(pattern)?.[1]);
    if (value !== null) return value;
  }
  return null;
}

function zeroWhenOnlyActionExists(text: string, action: string): 0 | null {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const hasAction = new RegExp(`(?:^|\\s|\\|)${escaped}(?:\\s|\\||$)`, "i").test(text);
  const hasCount = new RegExp(`\\d+\\s+${escaped}s?`, "i").test(text);
  return hasAction && !hasCount ? 0 : null;
}
