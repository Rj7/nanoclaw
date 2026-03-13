/**
 * X Integration - Shared utilities
 * Used by all X scripts
 */

import { chromium, BrowserContext, Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { config } from './config.js';

export { config };

export interface ScriptResult {
  success: boolean;
  message: string;
  data?: unknown;
}

/**
 * Read input from stdin
 */
export async function readInput<T>(): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(new Error(`Invalid JSON input: ${err}`));
      }
    });
    process.stdin.on('error', reject);
  });
}

/**
 * Write result to stdout
 */
export function writeResult(result: ScriptResult): void {
  console.log(JSON.stringify(result));
}

/**
 * Clean up browser lock files
 */
export function cleanupLockFiles(): void {
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = path.join(config.browserDataDir, lockFile);
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }
}

/**
 * Validate tweet/reply content
 */
export function validateContent(content: string | undefined, type = 'Tweet'): ScriptResult | null {
  if (!content || content.length === 0) {
    return { success: false, message: `${type} content cannot be empty` };
  }
  if (content.length > config.limits.tweetMaxLength) {
    return { success: false, message: `${type} exceeds ${config.limits.tweetMaxLength} character limit (current: ${content.length})` };
  }
  return null; // Valid
}

/**
 * Get browser context with persistent profile
 */
export async function getBrowserContext(): Promise<BrowserContext> {
  if (!fs.existsSync(config.authPath)) {
    throw new Error('X authentication not configured. Run /x-integration to complete login.');
  }

  cleanupLockFiles();

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: false,
    viewport: config.viewport,
    args: config.chromeArgs,
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  return context;
}

/**
 * Extract tweet ID from URL or raw ID
 */
export function extractTweetId(input: string): string | null {
  const urlMatch = input.match(/(?:x\.com|twitter\.com)\/\w+\/status\/(\d+)/);
  if (urlMatch) return urlMatch[1];
  if (/^\d+$/.test(input.trim())) return input.trim();
  return null;
}

/**
 * Navigate to a tweet page
 */
export async function navigateToTweet(
  context: BrowserContext,
  tweetUrl: string
): Promise<{ page: Page; success: boolean; error?: string }> {
  const page = context.pages()[0] || await context.newPage();

  let url = tweetUrl;
  const tweetId = extractTweetId(tweetUrl);
  if (tweetId && !tweetUrl.startsWith('http')) {
    url = `https://x.com/i/status/${tweetId}`;
  }

  try {
    await page.goto(url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const exists = await page.locator('article[data-testid="tweet"]').first().isVisible().catch(() => false);
    if (!exists) {
      return { page, success: false, error: 'Tweet not found. It may have been deleted or the URL is invalid.' };
    }

    return { page, success: true };
  } catch (err) {
    return { page, success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export interface TweetData {
  author: string;
  handle: string;
  text: string;
  url: string;
  time: string;
  likes: number;
  retweets: number;
  replies: number;
}

// Inline JS string for page.evaluate — must stay as a string to avoid tsx __name injection
const EXTRACT_TWEETS_JS = `(function() {
  var articles = document.querySelectorAll('article[data-testid="tweet"]');
  var results = [];
  for (var i = 0; i < articles.length; i++) {
    var article = articles[i];
    var userNameEl = article.querySelector('[data-testid="User-Name"]');
    var nameText = userNameEl ? userNameEl.textContent : '';
    var handleMatch = nameText.match(/@(\\\\w+)/);
    var handle = handleMatch ? '@' + handleMatch[1] : '';
    var displayName = nameText.split('@')[0].trim();
    var tweetTextEl = article.querySelector('[data-testid="tweetText"]');
    var tweetText = tweetTextEl ? tweetTextEl.textContent : '';
    var timeEl = article.querySelector('time');
    var time = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
    var linkEl = timeEl ? timeEl.closest('a') : null;
    var tweetLink = linkEl ? (linkEl.getAttribute('href') || '') : '';
    function getMetric(testId) {
      var el = article.querySelector('[data-testid="' + testId + '"]');
      if (!el) return 0;
      var label = el.getAttribute('aria-label') || '';
      var m = label.match(/(\\\\d[\\\\d,]*)/);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
    }
    results.push({
      author: displayName, handle: handle, text: tweetText,
      url: tweetLink ? 'https://x.com' + tweetLink : '',
      time: time, likes: getMetric('like'), retweets: getMetric('retweet'), replies: getMetric('reply')
    });
  }
  return results;
})()`;

/**
 * Scroll and collect tweets from the current page.
 */
export async function collectTweets(page: Page, count: number, maxScrolls = 8): Promise<TweetData[]> {
  const allTweets: TweetData[] = [];
  const seenUrls = new Set<string>();
  let scrollRounds = 0;

  while (allTweets.length < count && scrollRounds < maxScrolls) {
    const tweets: TweetData[] = await page.evaluate(EXTRACT_TWEETS_JS);

    for (const tweet of tweets) {
      if (tweet.url && !seenUrls.has(tweet.url) && tweet.text) {
        seenUrls.add(tweet.url);
        allTweets.push(tweet);
        if (allTweets.length >= count) break;
      }
    }

    if (allTweets.length >= count) break;

    await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
    await page.waitForTimeout(2000);
    scrollRounds++;
  }

  return allTweets;
}

/**
 * Run script with error handling
 */
export async function runScript<T>(
  handler: (input: T) => Promise<ScriptResult>
): Promise<void> {
  try {
    const input = await readInput<T>();
    const result = await handler(input);
    writeResult(result);
  } catch (err) {
    writeResult({
      success: false,
      message: `Script execution failed: ${err instanceof Error ? err.message : String(err)}`
    });
    process.exit(1);
  }
}
