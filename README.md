# LinkedIn Stats Agent

Local Puppeteer prototype for discovering personal LinkedIn posts from the last 30 days and writing visible post stats to JSON.

This prototype does not use LinkedIn OAuth, does not ask for cookies, and does not run a hosted browser. The user signs into LinkedIn manually in a visible Puppeteer browser. The session is kept locally in `.local/linkedin-profile/`.

## Setup

```bash
npm install
```

## Commands

```bash
npm run login
npm run collect
npm run inspect -- --url "https://www.linkedin.com/posts/..."
npm run dashboard
```

`npm run collect` writes:

```text
output/linkedin-post-stats.json
```

`npm run dashboard` opens a local web dashboard at:

```text
http://localhost:4173
```

The dashboard polls `output/linkedin-post-stats.json` every 2 seconds and updates the charts when the JSON changes.

## Notes

- LinkedIn UI and internal page structure can change. Expect selector tuning.
- Impressions are only captured when LinkedIn exposes author analytics in the visible UI.
- Missing stats are written as `null` instead of guessed.
- V1 uses conservative serial scraping and visible browser automation.
