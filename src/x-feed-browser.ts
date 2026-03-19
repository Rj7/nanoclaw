/**
 * X Feed Monitor - Persistent browser manager
 *
 * Keeps a single Chromium context alive for repeated polling.
 * Uses a SEPARATE browser profile from the on-demand X tools
 * to avoid Chrome lock contention.
 */

import fs from 'fs';
import path from 'path';

import { chromium, BrowserContext, Page } from 'playwright';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const BROWSER_DATA_DIR = path.join(DATA_DIR, 'x-feed-browser-profile');
const AUTH_PATH = path.join(DATA_DIR, 'x-feed-auth.json');

const CHROME_PATH =
  process.env.CHROME_PATH ||
  (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome');

const CHROME_ARGS = [
  '--disable-blink-features=AutomationControlled',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-sync',
];

const VIEWPORT = { width: 1280, height: 800 };

// Same extraction JS as the on-demand scripts — must stay as a string
// to avoid tsx __name injection in the browser context
export const EXTRACT_TWEETS_JS = `(function() {
  var articles = document.querySelectorAll('article[data-testid="tweet"]');
  var results = [];
  for (var i = 0; i < articles.length; i++) {
    var article = articles[i];
    var timeEl = article.querySelector('time');
    var time = timeEl ? (timeEl.getAttribute('datetime') || '') : '';
    var linkEl = timeEl ? timeEl.closest('a') : null;
    var tweetLink = linkEl ? (linkEl.getAttribute('href') || '') : '';
    var userNameEl = article.querySelector('[data-testid="User-Name"]');
    var nameText = userNameEl ? userNameEl.textContent : '';
    var handleMatch = nameText.match(/@([A-Za-z0-9_]+)/);
    var handle = handleMatch ? '@' + handleMatch[1] : '';
    if (!handle && tweetLink) {
      var urlMatch = tweetLink.match(/^\\/([A-Za-z0-9_]+)\\/status/);
      if (urlMatch) handle = '@' + urlMatch[1];
    }
    var displayName = nameText.split('@')[0].trim();
    var tweetTextEls = article.querySelectorAll('[data-testid="tweetText"]');
    var mainText = tweetTextEls.length > 0 ? tweetTextEls[0].textContent : '';
    var quotedText = '';
    if (tweetTextEls.length > 1) {
      var qt = tweetTextEls[tweetTextEls.length - 1].textContent || '';
      if (qt && qt !== mainText) quotedText = qt;
    }
    var tweetText = quotedText ? mainText + '\\n[Quoted] ' + quotedText : mainText;
    function getMetric(testId) {
      var el = article.querySelector('[data-testid="' + testId + '"]');
      if (!el) return 0;
      var label = el.getAttribute('aria-label') || '';
      var m = label.match(/([0-9][0-9,]*)/);
      return m ? parseInt(m[1].replace(/,/g, ''), 10) : 0;
    }
    var imageUrls = [];
    var imgEls = article.querySelectorAll('img[src*="pbs.twimg.com/media"]');
    for (var j = 0; j < imgEls.length; j++) {
      var src = imgEls[j].getAttribute('src') || '';
      if (src) imageUrls.push(src);
    }
    results.push({
      author: displayName, handle: handle, text: tweetText,
      quotedText: quotedText,
      url: tweetLink ? 'https://x.com' + tweetLink : '',
      time: time, likes: getMetric('like'), retweets: getMetric('retweet'), replies: getMetric('reply'),
      imageUrls: imageUrls
    });
  }
  return results;
})()`;

export interface TweetData {
  author: string;
  handle: string;
  text: string;
  quotedText: string;
  url: string;
  time: string;
  likes: number;
  retweets: number;
  replies: number;
  imageUrls: string[];
}

let context: BrowserContext | null = null;

function cleanupLockFiles(): void {
  for (const lockFile of [
    'SingletonLock',
    'SingletonSocket',
    'SingletonCookie',
  ]) {
    const lockPath = path.join(BROWSER_DATA_DIR, lockFile);
    if (fs.existsSync(lockPath)) {
      try {
        fs.unlinkSync(lockPath);
      } catch {}
    }
  }
}

export async function launch(): Promise<void> {
  if (context) return;

  fs.mkdirSync(BROWSER_DATA_DIR, { recursive: true });
  cleanupLockFiles();

  context = await chromium.launchPersistentContext(BROWSER_DATA_DIR, {
    executablePath: CHROME_PATH,
    headless: false,
    viewport: VIEWPORT,
    args: CHROME_ARGS,
    ignoreDefaultArgs: ['--enable-automation'],
  });

  logger.info('Browser launched (persistent context)');
}

export async function getPage(): Promise<Page> {
  if (!context) throw new Error('Browser not launched');
  return context.pages()[0] || (await context.newPage());
}

export async function checkLogin(page: Page): Promise<boolean> {
  const isLoggedIn = await page
    .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
    .isVisible()
    .catch(() => false);
  if (isLoggedIn) return true;

  const onLoginPage = await page
    .locator('input[autocomplete="username"]')
    .isVisible()
    .catch(() => false);
  return !onLoginPage;
}

export async function collectTweets(
  page: Page,
  count: number,
  maxScrolls: number,
): Promise<TweetData[]> {
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

    await page.evaluate('window.scrollBy(0, window.innerHeight * 2)');
    await page.waitForTimeout(2000);
    scrollRounds++;
  }

  return allTweets;
}

export async function close(): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
    context = null;
    logger.info('Browser closed');
  }
}

export function isOpen(): boolean {
  return context !== null;
}

export function isAuthenticated(): boolean {
  return fs.existsSync(AUTH_PATH);
}

export function getAuthPath(): string {
  return AUTH_PATH;
}

export function getBrowserDataDir(): string {
  return BROWSER_DATA_DIR;
}
