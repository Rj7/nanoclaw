/**
 * Substack Feed Monitor — Persistent data collector
 *
 * Polls the user's Substack inbox every 30 minutes and saves posts
 * to SQLite for on-demand querying by nanoclaw agents.
 *
 * Usage: node dist/substack-feed-monitor.js
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
} from './substack-feed-config.js';
import * as browser from './substack-feed-browser.js';
import {
  initDatabase,
  getStoredPostUrls,
  getAllSubstackPostUrls,
  saveSubstackFeedPostsBatch,
  pruneSubstackFeedPosts,
  type SubstackFeedPostRow,
} from './db.js';

const PID_FILE = path.join(DATA_DIR, 'substack-feed-monitor.pid');
const IMAGES_DIR = path.join(DATA_DIR, 'substack-images');

let running = true;
let pollCount = 0;
let lastBrowserRestart = Date.now();

function slugFromUrl(url: string): string {
  // Extract slug from URL like https://pub.substack.com/p/article-slug
  const match = url.match(/\/p\/([^?#]+)/);
  return match ? match[1] : 'unknown';
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
          // Follow redirect
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

async function downloadImages(
  imageUrls: string[],
  postUrl: string,
): Promise<string[]> {
  const slug = slugFromUrl(postUrl);
  const dir = path.join(IMAGES_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });

  const paths: string[] = [];
  // Limit to first 10 images per article
  for (let i = 0; i < Math.min(imageUrls.length, 10); i++) {
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
  }

  // Ensure browser is running
  if (!browser.isOpen()) {
    await browser.launch();
    lastBrowserRestart = Date.now();
  }

  const page = await browser.getPage();

  // Navigate to Substack inbox
  await page.goto('https://substack.com/inbox', {
    timeout: 30000,
    waitUntil: 'domcontentloaded',
  });
  await page.waitForTimeout(3000);

  // Check login
  const loggedIn = await browser.checkLogin(page);
  if (!loggedIn) {
    logger.error(
      'Substack login expired. Run `npx tsx src/substack-feed-setup.ts` to re-authenticate.',
    );
    await sleep(config.authFailureBackoffMs);
    return;
  }

  // Wait for posts to render
  await page
    .waitForSelector(
      'article, [class*="post-preview"], [class*="inbox-item"]',
      { timeout: 10000 },
    )
    .catch(() => null);

  // Collect posts
  const posts = await browser.collectPosts(
    page,
    config.postCount,
    config.maxScrolls,
  );

  if (posts.length === 0) {
    logger.debug({ pollCount }, 'No posts found in inbox');
    return;
  }

  // Check which posts we already have
  const postUrls = posts.filter((p) => p.url).map((p) => p.url);
  const storedUrls = getStoredPostUrls(postUrls);

  // Filter to new posts only
  const newPosts = posts.filter(
    (p) => p.url && p.title && !storedUrls.has(p.url),
  );

  if (newPosts.length === 0) {
    logger.debug({ total: posts.length, pollCount }, 'No new posts');
    return;
  }

  // Read and save each article individually (no batch — crash-safe)
  const now = new Date().toISOString();
  let inserted = 0;
  for (const post of newPosts) {
    logger.info({ url: post.url }, 'Reading full article');
    const article = await browser.readArticle(page, post.url);

    // Download images to disk
    let imagePathsJson: string | null = null;
    if (article && article.images.length > 0) {
      const paths = await downloadImages(article.images, post.url);
      if (paths.length > 0) {
        imagePathsJson = JSON.stringify(paths);
      }
    }

    // Save immediately after reading each article
    const saved = saveSubstackFeedPostsBatch([
      {
        post_url: post.url,
        title: article?.title || post.title,
        author: post.author,
        publication: post.publication,
        snippet: post.snippet || null,
        content: article?.content || null,
        images: imagePathsJson,
        word_count: article?.wordCount || 0,
        post_date: post.postDate || null,
        collected_at: now,
      },
    ]);
    inserted += saved;

    if (saved > 0) {
      logger.info(
        { url: post.url, wordCount: article?.wordCount || 0 },
        'Saved article',
      );
    }
  }

  if (inserted > 0) {
    logger.info(
      { inserted, total: posts.length, pollCount },
      'Poll cycle complete',
    );
  }

  // Prune old data periodically (every 50 polls ≈ 25 hours at 30min interval)
  if (pollCount % 50 === 0) {
    const pruned = pruneSubstackFeedPosts(90);
    if (pruned > 0) {
      logger.info({ pruned }, 'Pruned old Substack posts');
      // Clean up orphaned image directories
      try {
        const allUrls = getAllSubstackPostUrls();
        const activeSlugs = new Set(
          allUrls
            .map((url: string) => url.match(/\/p\/([^?#]+)/)?.[1])
            .filter(Boolean),
        );
        if (fs.existsSync(IMAGES_DIR)) {
          for (const dir of fs.readdirSync(IMAGES_DIR)) {
            if (!activeSlugs.has(dir)) {
              fs.rmSync(path.join(IMAGES_DIR, dir), {
                recursive: true,
                force: true,
              });
            }
          }
        }
      } catch (err) {
        logger.debug({ err }, 'Failed to clean orphaned image dirs');
      }
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
  logger.info('Substack Feed Monitor starting');

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
  logger.fatal({ err }, 'Substack Feed Monitor fatal error');
  process.exit(1);
});
