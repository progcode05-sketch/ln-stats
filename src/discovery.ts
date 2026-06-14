import { Page } from "puppeteer";
import { CONFIG } from "./config.js";
import { DiscoveredPost } from "./types.js";
import { normalizeWhitespace, parseLinkedInCount, postedAtTextLooksOlderThanWindow, sleep } from "./utils.js";

export async function discoverRecentPosts(page: Page): Promise<DiscoveredPost[]> {
  await page.goto("https://www.linkedin.com/in/me/recent-activity/all/", { waitUntil: "domcontentloaded" });
  await sleep(CONFIG.settleDelayMs);

  const posts = new Map<string, DiscoveredPost>();
  let reachedOlderPost = false;
  let previousHeight = 0;
  let stableScrolls = 0;

  for (let scrollIndex = 0; scrollIndex < CONFIG.maxScrolls; scrollIndex += 1) {
    const batch = await extractVisiblePosts(page);
    for (const post of batch) {
      if (post.postedAtText && postedAtTextLooksOlderThanWindow(post.postedAtText, CONFIG.windowDays)) {
        reachedOlderPost = true;
        continue;
      }
      posts.set(post.postUrl, post);
      if (posts.size >= CONFIG.maxPosts) break;
    }

    if (reachedOlderPost || posts.size >= CONFIG.maxPosts) break;

    const currentHeight = await page.evaluate(() => document.body.scrollHeight);
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await sleep(2_500);
    const nextHeight = await page.evaluate(() => document.body.scrollHeight);

    stableScrolls = nextHeight === currentHeight || nextHeight === previousHeight ? stableScrolls + 1 : 0;
    previousHeight = currentHeight;
    if (stableScrolls >= 3) break;
  }

  return Array.from(posts.values());
}

async function extractVisiblePosts(page: Page): Promise<DiscoveredPost[]> {
  const rawPosts = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll<HTMLElement>("[role='article'][data-urn], .feed-shared-update-v2[data-urn]"));
    const byUrl = new Map<
      string,
      {
        postUrl: string;
        activityUrn: string | null;
        analyticsUrl: string | null;
        postedAtText: string | null;
        textPreview: string | null;
        cardText: string;
        controls: string[];
      }
    >();

    for (const card of cards) {
      const urn = card.getAttribute("data-urn");
      if (!urn?.startsWith("urn:li:activity:")) continue;

      const postUrl = `https://www.linkedin.com/feed/update/${urn}/`;
      const analyticsUrl =
        Array.from(card.querySelectorAll<HTMLAnchorElement>("a[href*='/analytics/post-summary/']")).at(0)?.href.split("?")[0] || null;
      const cardText = card.textContent || "";
      const contentText =
        card.querySelector<HTMLElement>(".update-components-text, .feed-shared-inline-show-more-text, [data-test-id='main-feed-activity-card__commentary']")
          ?.textContent || cardText;
      const controls = Array.from(card.querySelectorAll<HTMLElement>("button, a"))
        .map((element) => `${element.getAttribute("aria-label") || ""} ${element.textContent || ""}`.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      const dateCandidate =
        card.querySelector("time")?.textContent ||
        card.querySelector(".update-components-actor__sub-description")?.textContent ||
        cardText.match(/\b(?:now|\d+\s*(?:mo|yr|s|m|h|d|w))\s*(?:\u2022|\u00b7|-)/i)?.[0] ||
        null;

      byUrl.set(postUrl, {
        postUrl,
        activityUrn: urn,
        analyticsUrl,
        postedAtText: dateCandidate,
        textPreview: contentText.slice(0, 800),
        cardText,
        controls
      });
    }

    return Array.from(byUrl.values());
  });

  return rawPosts
    .map((post) => {
      const postedAtText = cleanPostedAtText(post.postedAtText);
      return {
        postUrl: post.postUrl,
        activityUrn: post.activityUrn,
        analyticsUrl: post.analyticsUrl,
        postedAtText,
        textPreview: cleanTextPreview(post.textPreview, postedAtText),
        seedStats: extractSeedStats(post.cardText, post.controls)
      };
    })
    .filter((post) => /linkedin\.com\/(posts|feed\/update)/i.test(post.postUrl));
}

function cleanPostedAtText(value: string | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  const match = normalized.match(/\b(?:now|\d+\s*(?:mo|yr|s|m|h|d|w))\b/i);
  return match?.[0] ?? normalized.replace(/(?:\u2022|\u00b7|-)/g, "").trim();
}

function cleanTextPreview(value: string | null, postedAtText: string | null): string | null {
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  const withoutPrefix = normalized.replace(/^Feed post number \d+\s+/i, "");
  const dateIndex = postedAtText ? withoutPrefix.toLowerCase().indexOf(postedAtText.toLowerCase()) : -1;
  const afterDate =
    dateIndex >= 0 && postedAtText
      ? withoutPrefix.slice(dateIndex + postedAtText.length).replace(/^[^A-Za-z0-9]+/, "").trim()
      : withoutPrefix;
  const withoutActions = afterDate.split(/\s+(?:Like|Comment|Repost|Send)\s+/i)[0];
  return withoutActions.slice(0, 200);
}

function extractSeedStats(cardText: string, controls: string[]) {
  const text = normalizeWhitespace([cardText, ...controls].join(" | ")) || "";
  return {
    impressions: findMetric(text, ["impression", "view"]),
    reactions: findReactionCount(text),
    comments: findCountBeforeLabel(text, ["comment"]) ?? zeroWhenOnlyActionExists(text, "Comment"),
    reposts: findCountBeforeLabel(text, ["repost", "share"]) ?? zeroWhenOnlyActionExists(text, "Repost")
  };
}

function findMetric(text: string, labels: string[]): number | null {
  for (const label of labels) {
    const beforePattern = new RegExp(`(\\d+(?:[,.]\\d+)*(?:\\.\\d+)?\\s*[kmb]?)\\s+(?:\\w+\\s+){0,2}${label}s?`, "i");
    const beforeValue = parseLinkedInCount(text.match(beforePattern)?.[1]);
    if (beforeValue !== null) return beforeValue;

    const afterPattern = new RegExp(`${label}s?\\s+(?:\\w+\\s+){0,2}(\\d+(?:[,.]\\d+)*(?:\\.\\d+)?\\s*[kmb]?)`, "i");
    const afterValue = parseLinkedInCount(text.match(afterPattern)?.[1]);
    if (afterValue !== null) return afterValue;
  }
  return null;
}

function findReactionCount(text: string): number | null {
  return (
    findCountBeforeLabel(text, ["reaction", "like", "support", "insightful", "celebrate", "love"]) ??
    zeroWhenOnlyActionExists(text, "Like")
  );
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
