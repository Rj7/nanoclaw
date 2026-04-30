/**
 * X Feed Monitor — Persistent data collector
 *
 * Polls the user's X home timeline every few minutes and saves ALL tweets
 * to SQLite for on-demand querying by nanoclaw agents.
 *
 * Usage: node dist/x-feed-monitor.js
 */

import { createWriteStream } from 'fs';
import fs from 'fs';
import { request as httpsRequest } from 'https';
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
  updateXFeedTweetText,
  updateXFeedTweetReplyParent,
  pruneXFeedTweets,
  pruneXFeedSeen,
  type XFeedTweetRow,
} from './db.js';

const PID_FILE = path.join(DATA_DIR, 'x-feed-monitor.pid');
const IMAGES_DIR = path.join(DATA_DIR, 'x-images');
const TICKER_RE = /\$[A-Z]{1,5}\b/g;

let running = true;
let pollCount = 0;
let lastBrowserRestart = Date.now();
// X added a "Sort by" menu on the Following tab (Popular | Recent), defaulting
// to Popular. We must select Recent every browser session — the choice is held
// in SPA state and resets on context restart.
let sortedToRecent = false;

function extractTickers(text: string): string | null {
  const matches = text.match(TICKER_RE);
  if (!matches || matches.length === 0) return null;
  return [...new Set(matches)].join(',');
}

function slugFromTweetUrl(url: string): string {
  // Extract "handle/status/id" → "handle-id"
  const match = url.match(/x\.com\/([^/]+)\/status\/(\d+)/);
  return match ? `${match[1]}-${match[2]}` : 'unknown';
}

async function downloadImage(
  imageUrl: string,
  dir: string,
  index: number,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const ext = imageUrl.match(/\.(jpg|jpeg|png|gif|webp)/i)?.[1] || 'jpg';
      const filename = `img-${index}.${ext}`;
      const filePath = path.join(dir, filename);

      if (fs.existsSync(filePath)) {
        resolve(filePath);
        return;
      }

      const req = httpsRequest(imageUrl, { timeout: 15000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const location = res.headers.location;
          if (location) {
            downloadImage(location, dir, index).then(resolve);
            return;
          }
        }
        if (res.statusCode !== 200) {
          resolve(null);
          return;
        }
        const stream = createWriteStream(filePath);
        res.pipe(stream);
        stream.on('finish', () => resolve(filePath));
        stream.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.end();
    } catch {
      resolve(null);
    }
  });
}

async function downloadTweetImages(
  imageUrls: string[],
  tweetUrl: string,
): Promise<string[]> {
  if (imageUrls.length === 0) return [];
  const slug = slugFromTweetUrl(tweetUrl);
  const dir = path.join(IMAGES_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  const paths: string[] = [];
  for (let i = 0; i < Math.min(imageUrls.length, 4); i++) {
    const result = await downloadImage(imageUrls[i], dir, i);
    if (result) paths.push(result);
  }
  return paths;
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
    sortedToRecent = false;
  }

  // Ensure browser is running
  if (!browser.isOpen()) {
    await browser.launch();
    lastBrowserRestart = Date.now();
    sortedToRecent = false;
  }

  const page = await browser.getPage();

  // Navigate to home feed → Following tab
  await page.goto('https://x.com/home', {
    timeout: 30000,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(2000);

  // Wait for the tab strip to render. X hydrates tabs after DOMContentLoaded,
  // so a fixed 2s after goto isn't always enough on a cold browser.
  await page
    .waitForSelector('[role="tab"]', { timeout: 8000 })
    .catch(() => null);

  // Locate the home-feed tab strip. X currently renders tabs as
  // <div role="tab"> (no href), so we find them by role + text.
  // Returns the bbox of the tab matching the requested label.
  const findTabBbox = async (
    label: string,
  ): Promise<{
    x: number;
    y: number;
    w: number;
    h: number;
    selected: boolean;
  } | null> => {
    return (await page.evaluate(`(function(target) {
      var tabs = document.querySelectorAll('[role="tab"]');
      for (var i = 0; i < tabs.length; i++) {
        if ((tabs[i].textContent || '').trim().indexOf(target) === 0) {
          var r = tabs[i].getBoundingClientRect();
          return {
            x: r.x, y: r.y, w: r.width, h: r.height,
            selected: tabs[i].getAttribute('aria-selected') === 'true',
          };
        }
      }
      return null;
    })('${label}')`)) as {
      x: number;
      y: number;
      w: number;
      h: number;
      selected: boolean;
    } | null;
  };

  // Switch to Following tab if not already there. Click the center of the
  // tab to switch (clicking near the right-edge caret only opens Sort by).
  const followingBbox = await findTabBbox('Following');
  if (!followingBbox) {
    logger.warn('Following tab not found in DOM — X markup may have changed');
  } else {
    if (!followingBbox.selected) {
      await page.mouse.click(
        followingBbox.x + followingBbox.w / 2,
        followingBbox.y + followingBbox.h / 2,
      );
      await page.waitForTimeout(1500);
    }

    // Set sort to Recent. The Following tab has a small caret SVG near its
    // right edge that opens a "Sort by" menu (Popular | Recent). Default is
    // Popular which returns very few tweets. The SVG itself has
    // pointer-events:none — clicks must land on the wrapper, so we click
    // a few pixels in from the tab's right edge. Selection persists in
    // SPA state across polls and resets when the browser context restarts.
    if (!sortedToRecent) {
      const tryOpenAndSelect = async (): Promise<{
        clicked: boolean;
        labels: string[];
      }> => {
        const bb = (await findTabBbox('Following')) || followingBbox;
        await page.mouse.click(bb.x + bb.w - 8, bb.y + bb.h / 2);
        await page.waitForTimeout(1200);
        return (await page.evaluate(`(function() {
          var items = document.querySelectorAll('[role="menuitem"], [role="menuitemradio"]');
          var labels = [];
          var clicked = false;
          for (var i = 0; i < items.length; i++) {
            var label = (items[i].textContent || '').trim();
            labels.push(label);
            if (!clicked && label === 'Recent') {
              items[i].click();
              clicked = true;
            }
          }
          return { clicked: clicked, labels: labels };
        })()`)) as { clicked: boolean; labels: string[] };
      };

      try {
        let result = await tryOpenAndSelect();
        if (!result.clicked && result.labels.length === 0) {
          // First click whiffed — wait for the page to settle and retry once.
          await page.waitForTimeout(1500);
          result = await tryOpenAndSelect();
        }

        if (result.clicked) {
          await page.waitForTimeout(2000);
          sortedToRecent = true;
          logger.info('Following sort set to Recent');
        } else {
          await page.keyboard.press('Escape').catch(() => {});
          logger.warn(
            { menuItems: result.labels },
            'Sort by menu did not expose a Recent option',
          );
        }
      } catch (err) {
        logger.warn({ err: String(err) }, 'Sort menu interaction failed');
      }
    }
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

  logger.info({ pollCount, scraped: tweets.length }, 'Poll scraped');
  if (tweets.length === 0) {
    return;
  }

  // Check which tweets we already have
  const tweetUrls = tweets.filter((t) => t.url).map((t) => t.url);
  const storedUrls = getStoredTweetUrls(tweetUrls);

  // Build rows for new tweets only, downloading images
  const now = new Date().toISOString();
  const newTweets: XFeedTweetRow[] = [];
  for (const tweet of tweets) {
    if (!tweet.url || !tweet.text || storedUrls.has(tweet.url)) continue;

    let images: string | null = null;
    if (tweet.imageUrls && tweet.imageUrls.length > 0) {
      try {
        const paths = await downloadTweetImages(tweet.imageUrls, tweet.url);
        if (paths.length > 0) images = JSON.stringify(paths);
      } catch (err) {
        logger.debug(
          { err, url: tweet.url },
          'Failed to download tweet images',
        );
      }
    }

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
      images,
      in_reply_to: tweet.inReplyToHandle || null,
      quoted_tweet_url: tweet.quotedTweetUrl || null,
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

  // Expand truncated tweets by opening them in a new tab
  const truncatedNew = newTweets.filter(
    (t) => tweets.find((raw) => raw.url === t.tweet_url)?.truncated,
  );
  if (truncatedNew.length > 0) {
    try {
      const expanded = await browser.expandTruncatedTweets(
        tweets.filter(
          (t) => t.truncated && truncatedNew.some((n) => n.tweet_url === t.url),
        ),
      );
      for (const [url, fullText] of expanded) {
        const tickers = extractTickers(fullText);
        updateXFeedTweetText(url, fullText, tickers);
      }
      if (expanded.size > 0) {
        logger.info({ expanded: expanded.size }, 'Expanded truncated tweets');
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to expand truncated tweets');
    }
  }

  // Resolve reply parents by opening reply tweets and extracting the parent URL
  const replyNew = newTweets.filter(
    (t) => t.in_reply_to && !t.in_reply_to.startsWith('https://'),
  );
  if (replyNew.length > 0) {
    try {
      const resolved = await browser.resolveReplyParents(
        tweets.filter(
          (t) =>
            t.inReplyToHandle && replyNew.some((n) => n.tweet_url === t.url),
        ),
      );
      for (const [replyUrl, parentUrl] of resolved) {
        updateXFeedTweetReplyParent(replyUrl, parentUrl);
      }
      if (resolved.size > 0) {
        logger.info({ resolved: resolved.size }, 'Resolved reply parents');
      }
    } catch (err) {
      logger.debug({ err }, 'Failed to resolve reply parents');
    }
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
