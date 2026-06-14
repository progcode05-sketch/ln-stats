import fs from "node:fs/promises";
import path from "node:path";
import { CONFIG } from "./config.js";
import { launchBrowser, newLinkedInPage, ensureServerLoggedIn } from "./browser.js";
import { discoverRecentPosts } from "./discovery.js";
import { collectPostStats } from "./stats.js";
import { getCredentials, createCollection, savePosts, finishCollection, failCollection } from "./db.js";
import { updateJob } from "./jobs.js";
import { CollectedPost } from "./types.js";

// Runs a full headless collection for one user, streaming progress into the
// job registry (which the SSE endpoint relays to the browser).
export async function runCollection(userId: string): Promise<void> {
  const creds = getCredentials(userId);
  if (!creds) {
    updateJob(userId, { phase: "error", error: "No LinkedIn credentials saved.", progress: null });
    return;
  }

  const collectionId = createCollection(userId);
  updateJob(userId, {
    collectionId,
    phase: "starting",
    progress: { current: 0, total: 0, message: "Launching secure browser…" }
  });

  const userDataDir = path.join(CONFIG.profilesDir, userId);
  await fs.mkdir(userDataDir, { recursive: true });

  let browser;
  try {
    browser = await launchBrowser({ headless: true, userDataDir });
    const page = await newLinkedInPage(browser);

    updateJob(userId, {
      phase: "connecting",
      progress: { current: 0, total: 0, message: "Signing in to LinkedIn…" }
    });
    await ensureServerLoggedIn(page, creds, () => {
      updateJob(userId, {
        phase: "connecting",
        progress: { current: 0, total: 0, message: "Signing in to LinkedIn…" }
      });
    });

    updateJob(userId, {
      phase: "collecting",
      progress: { current: 0, total: 0, message: "Finding your recent posts…" }
    });
    const posts = await discoverRecentPosts(page);

    const collected: CollectedPost[] = [];
    for (const [i, post] of posts.entries()) {
      updateJob(userId, {
        phase: "collecting",
        progress: {
          current: i + 1,
          total: posts.length,
          message: `Collecting stats for post ${i + 1} of ${posts.length}…`
        }
      });
      collected.push(await collectPostStats(page, post));
    }

    savePosts(collectionId, collected);
    finishCollection(collectionId);

    updateJob(userId, {
      phase: "done",
      progress: { current: collected.length, total: collected.length, message: "Done" },
      error: null
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    failCollection(collectionId, message);
    updateJob(userId, { phase: "error", error: message, progress: null });
  } finally {
    await browser?.close().catch(() => undefined);
  }
}
