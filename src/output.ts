import fs from "node:fs/promises";
import { CONFIG } from "./config.js";
import { CollectionOutput } from "./types.js";
import { ensureParentDir } from "./utils.js";

export async function writeCollectionOutput(posts: CollectionOutput["posts"]): Promise<string> {
  const output: CollectionOutput = {
    collectedAt: new Date().toISOString(),
    source: "linkedin-profile-activity",
    windowDays: CONFIG.windowDays,
    posts
  };

  await ensureParentDir(CONFIG.outputPath);
  await fs.writeFile(CONFIG.outputPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  return CONFIG.outputPath;
}
