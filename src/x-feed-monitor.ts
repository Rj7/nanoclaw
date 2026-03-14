/**
 * X Feed Monitor — Persistent data collector
 *
 * Polls the user's X home timeline every few minutes and saves ALL tweets
 * to SQLite for on-demand querying by nanoclaw agents.
 *
 * Usage: node dist/x-feed-monitor.js
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  loadConfig,
  reloadConfigIfChanged,
  getConfigPath,
} from './x-feed-config.js';
import * as browser from './x-feed-browser.js';
import {
  initDatabase,
  getStoredTweetUrls,
  saveXFeedTweetsBatch,
  pruneXFeedTweets,
  pruneXFeedSeen,
  type XFeedTweetRow,
} from './db.js';

const PID_FILE = path.join(DATA_DIR, 'x-feed-monitor.pid');
const TICKER_RE = /\$[A-Z]{1,5}\b/g;

let running = true;
let pollCount = 0;
let lastBrowserRestart = Date.now();

function extractTickers(text: string): string | null {
  const matches = text.match(TICKER_RE);
  if (!matches || matches.length === 0) return null;
  return [...new Set(matches)].join(',');
}

async function pollCycle(): Promise<void> {
  const config = reloadConfigIfChanged();
  pollCount++;

  // Periodic browser restart to prevent memory leaks
  if (
    browser.isOpen() &&
    Date.now() - lastBrowserRestart > config.browserRestartIntervalMs
  ) {
    logger.info('Periodic browser restart');
    await browser.close();
    lastBrowserRestart = Date.now();
  }

  // Ensure browser is running
  if (!browser.isOpen()) {
    await browser.launch();
    lastBrowserRestart = Date.now();
  }

  const page = await browser.getPage();

  // Navigate to home feed → Following tab
  await page.goto('https://x.com/home', {
    timeout: 30000,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2000);

  // Click "Following" tab (not the default "For you" algorithmic feed)
  const followingTab = page.locator('a[role="tab"][href="/home"]', {
    hasText: 'Following',
  });
  if (await followingTab.isVisible().catch(() => false)) {
    await followingTab.click();
    await page.waitForTimeout(2000);
  }

  // Check login
  const loggedIn = await browser.checkLogin(page);
  if (!loggedIn) {
    logger.error(
      'X login expired. Run `npx tsx src/x-feed-setup.ts` to re-authenticate.',
    );
    await sleep(config.authFailureBackoffMs);
    return;
  }

  // Wait for tweets
  await page
    .waitForSelector('article[data-testid="tweet"]', { timeout: 10000 })
    .catch(() => null);

  // Collect tweets
  const tweets = await browser.collectTweets(
    page,
    config.tweetCount,
    config.maxScrolls,
  );

  if (tweets.length === 0) {
    logger.debug({ pollCount }, 'No tweets found on feed');
    return;
  }

  // Check which tweets we already have
  const tweetUrls = tweets.filter((t) => t.url).map((t) => t.url);
  const storedUrls = getStoredTweetUrls(tweetUrls);

  // Build rows for new tweets only
  const now = new Date().toISOString();
  const newTweets: XFeedTweetRow[] = [];
  for (const tweet of tweets) {
    if (!tweet.url || !tweet.text || storedUrls.has(tweet.url)) continue;
    newTweets.push({
      tweet_url: tweet.url,
      author: tweet.author,
      handle: tweet.handle,
      text: tweet.text,
      tickers: extractTickers(tweet.text),
      tweet_time: tweet.time || null,
      likes: tweet.likes,
      retweets: tweet.retweets,
      replies: tweet.replies,
      collected_at: now,
    });
  }

  // Save to database
  const inserted = saveXFeedTweetsBatch(newTweets);
  if (inserted > 0) {
    logger.info(
      { inserted, total: tweets.length, pollCount },
      'Saved new tweets',
    );
  } else {
    logger.debug({ total: tweets.length, pollCount }, 'No new tweets');
  }

  // Prune old data periodically (every 100 polls)
  if (pollCount % 100 === 0) {
    const pruned = pruneXFeedTweets(30);
    const prunedSeen = pruneXFeedSeen(7);
    if (pruned > 0 || prunedSeen > 0) {
      logger.info({ pruned, prunedSeen }, 'Pruned old tweets');
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addJitter(ms: number): number {
  const factor = 0.8 + Math.random() * 0.4; // 0.8x to 1.2x
  return Math.round(ms * factor);
}

async function main(): Promise<void> {
  logger.info('X Feed Monitor starting');

  // Initialize database (same store as main nanoclaw)
  initDatabase();

  // Write PID file
  fs.mkdirSync(path.dirname(PID_FILE), { recursive: true });
  fs.writeFileSync(PID_FILE, String(process.pid));

  // Load config
  const config = loadConfig();
  logger.info(
    {
      pollInterval: `${config.pollIntervalMs / 1000}s`,
      configPath: getConfigPath(),
    },
    'Config loaded',
  );

  // Graceful shutdown
  const shutdown = async () => {
    running = false;
    logger.info('Shutting down...');
    await browser.close();
    try {
      fs.unlinkSync(PID_FILE);
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  // Main poll loop
  while (running) {
    try {
      await pollCycle();
    } catch (err) {
      logger.error({ err }, 'Poll cycle error');
      // If browser crashed, close it so next cycle relaunches
      if (browser.isOpen()) {
        await browser.close().catch(() => {});
      }
    }

    if (running) {
      const interval = addJitter(reloadConfigIfChanged().pollIntervalMs);
      await sleep(interval);
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'X Feed Monitor fatal error');
  process.exit(1);
});
