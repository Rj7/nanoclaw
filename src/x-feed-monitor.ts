/**
 * X Feed Monitor — Persistent process
 *
 * Polls the user's X home timeline every few minutes, detects new posts
 * matching stock signals (tickers, keywords, watchlist accounts), and
 * sends notifications via IPC to the main nanoclaw process.
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
import { filterTweets } from './x-feed-filter.js';
import { notifyBatch, writeIpcMessage } from './x-feed-notify.js';
import {
  initDatabase,
  getSeenTweetUrls,
  markXFeedTweetsBatch,
  pruneXFeedSeen,
  getAllRegisteredGroups,
} from './db.js';

const PID_FILE = path.join(DATA_DIR, 'x-feed-monitor.pid');

function getMainGroupFolder(): string | null {
  const groups = getAllRegisteredGroups();
  for (const [, group] of Object.entries(groups)) {
    if (group.isMain) return group.folder;
  }
  // Fallback: first registered group
  const first = Object.values(groups)[0];
  return first?.folder || null;
}

let running = true;
let pollCount = 0;
let lastBrowserRestart = Date.now();

async function pollCycle(groupFolder: string): Promise<void> {
  const config = reloadConfigIfChanged();
  pollCount++;

  if (!config.targetChatJid) {
    if (pollCount === 1) {
      logger.warn('No targetChatJid configured — edit ' + getConfigPath());
    }
    return;
  }

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

  // Navigate to home feed
  await page.goto('https://x.com/home', {
    timeout: 30000,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(3000);

  // Check login
  const loggedIn = await browser.checkLogin(page);
  if (!loggedIn) {
    logger.error(
      'X login expired. Authenticate the feed monitor browser profile.',
    );
    // Notify user
    writeIpcMessage(
      config.targetChatJid,
      '*X Feed Monitor*: Login expired. Run `npx tsx src/x-feed-setup.ts` to re-authenticate.',
      groupFolder,
    );

    // Wait longer before retrying
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

  // Batch-check which tweets we've already seen (single query)
  const tweetUrls = tweets.filter((t) => t.url).map((t) => t.url);
  const seenUrls = getSeenTweetUrls(tweetUrls);

  // Filter for signals
  const matches = filterTweets(tweets, config, (url) => seenUrls.has(url));

  // Batch-mark ALL tweets as seen (single transaction)
  markXFeedTweetsBatch(tweets.filter((t) => t.url));

  if (matches.length > 0) {
    logger.info(
      { matches: matches.length, total: tweets.length, pollCount },
      'Stock signals detected',
    );
    notifyBatch(config.targetChatJid, matches, groupFolder);
  } else {
    logger.debug(
      { total: tweets.length, pollCount },
      'No matches this cycle',
    );
  }

  // Prune seen table periodically (every 100 polls ≈ every 5 hours at 3min interval)
  if (pollCount % 100 === 0) {
    const pruned = pruneXFeedSeen(7);
    if (pruned > 0) {
      logger.info({ pruned }, 'Pruned old seen tweets');
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
  let config = loadConfig();
  logger.info(
    {
      pollInterval: `${config.pollIntervalMs / 1000}s`,
      watchlist: config.watchlistAccounts.length,
      keywords: config.keywords.length,
      configPath: getConfigPath(),
    },
    'Config loaded',
  );

  if (!config.targetChatJid) {
    logger.error(
      'targetChatJid not set in config. Edit ' +
        getConfigPath() +
        ' and set it to your main group JID.',
    );
  }

  // Resolve main group folder for IPC
  const groupFolder = getMainGroupFolder();
  if (!groupFolder) {
    logger.error(
      'No registered groups found. Start nanoclaw and register a group first.',
    );
    process.exit(1);
  }
  logger.info({ groupFolder }, 'Using group folder for IPC');

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
      await pollCycle(groupFolder);
    } catch (err) {
      logger.error({ err }, 'Poll cycle error');
      // If browser crashed, close it so next cycle relaunches
      if (browser.isOpen()) {
        await browser.close().catch(() => {});
      }
    }

    if (running) {
      config = reloadConfigIfChanged();
      const interval = addJitter(config.pollIntervalMs);
      await sleep(interval);
    }
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'X Feed Monitor fatal error');
  process.exit(1);
});
