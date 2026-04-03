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
    var showMoreEl = article.querySelector('[data-testid="tweet-text-show-more-link"]');
    var truncated = !!showMoreEl;
    // Detect reply context — X renders "Replying to @handle" above the tweet text
    var inReplyToUrl = '';
    var socialCtx = article.querySelectorAll('a[href*="/status/"]');
    // Check for "Replying to" text in the social context area above tweet text
    var replyCtxEl = article.querySelector('[data-testid="User-Name"]');
    var parentEl = replyCtxEl ? replyCtxEl.parentElement : null;
    // Walk siblings above the tweet text looking for reply indicator
    var allText = article.innerText || '';
    var replyMatch = allText.match(/Replying to\\s+@([A-Za-z0-9_]+)/);
    if (replyMatch && tweetLink) {
      // This tweet is a reply — build parent URL from conversation thread
      // The tweet URL contains the conversation; X embeds the parent in the thread view
      inReplyToUrl = '@' + replyMatch[1];
    }
    // Detect quoted tweet URL from the embedded quote container
    var quotedTweetUrl = '';
    var quotedContainer = article.querySelector('[data-testid="quoteTweet"]') || article.querySelector('div[role="link"][tabindex="0"]');
    if (quotedContainer && quotedText) {
      var qtLink = quotedContainer.querySelector('a[href*="/status/"]');
      if (qtLink) {
        var qtHref = qtLink.getAttribute('href') || '';
        if (qtHref && qtHref !== tweetLink) quotedTweetUrl = 'https://x.com' + qtHref;
      }
    }
    results.push({
      author: displayName, handle: handle, text: tweetText,
      quotedText: quotedText, truncated: truncated,
      url: tweetLink ? 'https://x.com' + tweetLink : '',
      time: time, likes: getMetric('like'), retweets: getMetric('retweet'), replies: getMetric('reply'),
      imageUrls: imageUrls,
      inReplyToHandle: inReplyToUrl,
      quotedTweetUrl: quotedTweetUrl
    });
  }
  return results;
})()`;

export interface TweetData {
  author: string;
  handle: string;
  text: string;
  quotedText: string;
  truncated: boolean;
  url: string;
  time: string;
  likes: number;
  retweets: number;
  replies: number;
  imageUrls: string[];
  inReplyToHandle: string;
  quotedTweetUrl: string;
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

// JS to extract full tweet text from an individual tweet page
const EXTRACT_FULL_TWEET_JS = `(function() {
  var article = document.querySelector('article[data-testid="tweet"]');
  if (!article) return null;
  var tweetTextEls = article.querySelectorAll('[data-testid="tweetText"]');
  var mainText = tweetTextEls.length > 0 ? tweetTextEls[0].textContent : '';
  var quotedText = '';
  if (tweetTextEls.length > 1) {
    var qt = tweetTextEls[tweetTextEls.length - 1].textContent || '';
    if (qt && qt !== mainText) quotedText = qt;
  }
  return quotedText ? mainText + '\\n[Quoted] ' + quotedText : mainText;
})()`;

/**
 * Open each truncated tweet in a new tab and extract the full text.
 * Returns a map of tweet URL → full text for tweets that were expanded.
 */
export async function expandTruncatedTweets(
  tweets: TweetData[],
): Promise<Map<string, string>> {
  const truncated = tweets.filter((t) => t.truncated && t.url);
  if (truncated.length === 0 || !context) return new Map();

  const expanded = new Map<string, string>();
  const page = await context.newPage();

  try {
    for (const tweet of truncated) {
      try {
        await page.goto(tweet.url, {
          timeout: 15000,
          waitUntil: 'domcontentloaded',
        });
        await page
          .waitForSelector('[data-testid="tweetText"]', { timeout: 8000 })
          .catch(() => null);
        await page.waitForTimeout(1000);

        const fullText: string | null = await page.evaluate(
          EXTRACT_FULL_TWEET_JS,
        );
        if (fullText && fullText.length > tweet.text.length) {
          expanded.set(tweet.url, fullText);
          logger.info(
            {
              url: tweet.url,
              before: tweet.text.length,
              after: fullText.length,
            },
            'Expanded truncated tweet',
          );
        }
      } catch (err) {
        logger.debug({ err, url: tweet.url }, 'Failed to expand tweet');
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return expanded;
}

// JS to extract the parent tweet URL + text from an individual tweet's thread page.
// When viewing a reply, X renders the parent tweet(s) as articles above the focused one.
// The focused tweet's URL matches the page URL; the parent is the article before it.
const EXTRACT_PARENT_TWEET_JS = `(function() {
  var articles = document.querySelectorAll('article[data-testid="tweet"]');
  if (articles.length < 2) return null;
  // The first article in the thread is the parent (or earliest ancestor)
  var parent = articles[0];
  var timeEl = parent.querySelector('time');
  var linkEl = timeEl ? timeEl.closest('a') : null;
  var href = linkEl ? (linkEl.getAttribute('href') || '') : '';
  var url = href ? 'https://x.com' + href : '';
  var userNameEl = parent.querySelector('[data-testid="User-Name"]');
  var nameText = userNameEl ? userNameEl.textContent : '';
  var handleMatch = nameText.match(/@([A-Za-z0-9_]+)/);
  var handle = handleMatch ? '@' + handleMatch[1] : '';
  var tweetTextEls = parent.querySelectorAll('[data-testid="tweetText"]');
  var text = tweetTextEls.length > 0 ? tweetTextEls[0].textContent : '';
  if (!url) return null;
  return { url: url, handle: handle, text: text };
})()`;

/**
 * Open each reply tweet in a new tab and extract the parent tweet URL.
 * Returns a map of reply tweet URL → parent tweet URL.
 */
export async function resolveReplyParents(
  tweets: TweetData[],
): Promise<Map<string, string>> {
  const replies = tweets.filter((t) => t.inReplyToHandle && t.url);
  if (replies.length === 0 || !context) return new Map();

  const resolved = new Map<string, string>();
  const page = await context.newPage();

  try {
    for (const tweet of replies) {
      try {
        await page.goto(tweet.url, {
          timeout: 15000,
          waitUntil: 'domcontentloaded',
        });
        await page
          .waitForSelector('article[data-testid="tweet"]', { timeout: 8000 })
          .catch(() => null);
        await page.waitForTimeout(1000);

        const parent = await page.evaluate(EXTRACT_PARENT_TWEET_JS) as {
          url: string;
          handle: string;
          text: string;
        } | null;

        if (parent?.url && parent.url !== tweet.url) {
          resolved.set(tweet.url, parent.url);
          logger.info(
            { reply: tweet.url, parent: parent.url },
            'Resolved reply parent',
          );
        }
      } catch (err) {
        logger.debug({ err, url: tweet.url }, 'Failed to resolve reply parent');
      }
    }
  } finally {
    await page.close().catch(() => {});
  }

  return resolved;
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
