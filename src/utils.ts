import fs from "node:fs/promises";
import path from "node:path";

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureParentDir(filePath: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export function normalizeWhitespace(value: string | null | undefined): string | null {
  if (!value) return null;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : null;
}

export function parseLinkedInCount(text: string | null | undefined): number | null {
  if (!text) return null;
  const normalized = text
    .replace(/,/g, "")
    .replace(/\b(reactions?|likes?|comments?|reposts?|shares?|impressions?|views?)\b/gi, "")
    .trim();
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*([kmb])?/i);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2]?.toLowerCase();
  const multiplier = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : suffix === "b" ? 1_000_000_000 : 1;
  return Math.round(value * multiplier);
}

export function isLikelyLoginUrl(url: string): boolean {
  return /linkedin\.com\/(login|checkpoint|uas\/login)/i.test(url);
}

export function postedAtTextLooksOlderThanWindow(text: string | null, windowDays: number): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  const numberMatch = lower.match(/(\d+)/);
  const value = numberMatch ? Number.parseInt(numberMatch[1], 10) : 1;
  if (!Number.isFinite(value)) return false;
  if (/\d+\s*mo\b|month|\d+\s*yr\b|year/.test(lower)) return true;
  if (/\d+\s*w\b|week/.test(lower)) return value * 7 > windowDays;
  if (/\d+\s*d\b|day/.test(lower)) return value > windowDays;
  return false;
}
