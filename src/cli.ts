import { launchLinkedInBrowser, ensureLoggedIn, newLinkedInPage } from "./browser.js";
import { discoverRecentPosts } from "./discovery.js";
import { collectPostStats } from "./stats.js";
import { writeCollectionOutput } from "./output.js";

async function main(): Promise<void> {
  const command = process.argv[2];

  if (!command || command === "--help" || command === "-h") {
    printUsage();
    return;
  }

  if (command === "login") {
    await runLogin();
    return;
  }

  if (command === "collect") {
    await runCollect();
    return;
  }

  if (command === "inspect") {
    await runInspect();
    return;
  }

  printUsage();
  process.exitCode = 1;
}

async function runLogin(): Promise<void> {
  const browser = await launchLinkedInBrowser();
  const page = await newLinkedInPage(browser);
  await ensureLoggedIn(page);
  console.log("LinkedIn session is ready. You can close the browser window.");
  await waitForBrowserClose(browser);
}

async function runCollect(): Promise<void> {
  const browser = await launchLinkedInBrowser();
  const page = await newLinkedInPage(browser);

  try {
    await ensureLoggedIn(page);
    console.log("Discovering recent posts from your profile activity...");
    const posts = await discoverRecentPosts(page);
    console.log(`Discovered ${posts.length} candidate posts.`);

    const collected = [];
    for (const [index, post] of posts.entries()) {
      console.log(`Collecting stats ${index + 1}/${posts.length}: ${post.postUrl}`);
      collected.push(await collectPostStats(page, post));
    }

    const outputPath = await writeCollectionOutput(collected);
    console.log(`Wrote LinkedIn post stats to ${outputPath}`);
  } finally {
    await browser.close();
  }
}

async function runInspect(): Promise<void> {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    printUsage();
    return;
  }

  const url = readArg("--url") || process.argv[3] || "https://www.linkedin.com/in/me/recent-activity/all/";
  const browser = await launchLinkedInBrowser();
  const page = await newLinkedInPage(browser);
  await ensureLoggedIn(page);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  console.log(`Inspecting ${url}`);
  console.log("Use the visible browser/devtools to inspect selectors. Close the browser when done.");
  await waitForBrowserClose(browser);
}

function readArg(name: string): string | null {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  return process.argv[index + 1] || null;
}

async function waitForBrowserClose(browser: Awaited<ReturnType<typeof launchLinkedInBrowser>>): Promise<void> {
  await new Promise<void>((resolve) => {
    browser.on("disconnected", resolve);
  });
}

function printUsage(): void {
  console.log(`Usage:
  npm run login
  npm run collect
  npm run inspect -- --url "https://www.linkedin.com/posts/..."
`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
