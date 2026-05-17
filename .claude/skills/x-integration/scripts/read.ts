#!/usr/bin/env npx tsx
/**
 * X Integration - Read a single tweet URL with full context.
 *
 * Fetches the focal tweet plus:
 *   - parent reply chain (tweets the focal is a reply to, rendered above)
 *   - author's self-thread continuation (chained replies by the same author)
 *   - quoted tweet metadata if present
 *   - all images, downloaded locally + their CDN URLs
 *
 * This is the default tool when a tweet URL is shared in chat — it gives the
 * agent everything visible on the tweet page without needing further calls.
 *
 * Usage: echo '{"tweet_url":"https://x.com/user/status/123"}' | npx tsx read.ts
 */
import { createWriteStream } from 'fs';
import fs from 'fs';
import { request as httpsRequest } from 'https';
import path from 'path';

import {
  getBrowserContext,
  runScript,
  config,
  ScriptResult,
  extractTweetId,
} from '../lib/browser.js';

interface ReadInput {
  tweet_url: string;
}

interface TweetData {
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
  inReplyToHandle: string;
  quotedTweetUrl: string;
  truncated: boolean;
  imagePaths?: string[];
}

const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();
const MEDIA_DIR = path.join(PROJECT_ROOT, 'data', 'shared', 'x-media');

const EXTRACT_TWEETS_JS = `(function() {
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
    var inReplyToHandle = '';
    var replyMatch = (article.textContent || '').match(/Replying to\\s+@([A-Za-z0-9_]+)/);
    if (replyMatch) inReplyToHandle = '@' + replyMatch[1];
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
      author: displayName, handle: handle, text: mainText,
      quotedText: quotedText, truncated: truncated,
      url: tweetLink ? 'https://x.com' + tweetLink : '',
      time: time, likes: getMetric('like'), retweets: getMetric('retweet'), replies: getMetric('reply'),
      imageUrls: imageUrls,
      inReplyToHandle: inReplyToHandle,
      quotedTweetUrl: quotedTweetUrl
    });
  }
  return results;
})()`;

function slugFromTweetUrl(url: string): string {
  const match = url.match(/x\.com\/([^/]+)\/status\/(\d+)/);
  return match ? `${match[1]}-${match[2]}` : 'unknown';
}

function upgradeImageUrl(src: string): string {
  // Force large variant — X serves smaller resolutions by default in feeds
  try {
    const u = new URL(src);
    if (u.hostname.includes('pbs.twimg.com')) {
      u.searchParams.set('name', 'large');
      if (!u.searchParams.get('format')) u.searchParams.set('format', 'jpg');
    }
    return u.toString();
  } catch {
    return src;
  }
}

function downloadOne(
  url: string,
  filePath: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      if (fs.existsSync(filePath)) {
        resolve(filePath);
        return;
      }
      const req = httpsRequest(url, { timeout: 15000 }, (res) => {
        if ((res.statusCode === 301 || res.statusCode === 302) && res.headers.location) {
          downloadOne(res.headers.location, filePath).then(resolve);
          return;
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

async function downloadTweetMedia(tweet: TweetData): Promise<string[]> {
  if (!tweet.imageUrls || tweet.imageUrls.length === 0 || !tweet.url) return [];
  const slug = slugFromTweetUrl(tweet.url);
  const dir = path.join(MEDIA_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  const paths: string[] = [];
  for (let i = 0; i < tweet.imageUrls.length; i++) {
    const upgraded = upgradeImageUrl(tweet.imageUrls[i]);
    const ext = upgraded.match(/format=([a-z]+)/i)?.[1] || 'jpg';
    const filePath = path.join(dir, `img-${i}.${ext}`);
    const saved = await downloadOne(upgraded, filePath);
    if (saved) paths.push(saved);
  }
  return paths;
}

async function readTweet(input: ReadInput): Promise<ScriptResult> {
  const url = input.tweet_url;
  if (!url) return { success: false, message: 'tweet_url is required' };
  const tweetId = extractTweetId(url);
  if (!tweetId) {
    return { success: false, message: `Could not extract tweet ID from: ${url}` };
  }

  const fullUrl = url.startsWith('http') ? url : `https://x.com/i/status/${tweetId}`;

  let context = null;
  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || (await context.newPage());

    await page.goto(fullUrl, {
      timeout: config.timeouts.navigation,
      waitUntil: 'domcontentloaded',
    });
    await page.waitForTimeout(config.timeouts.pageLoad);

    const isLoggedIn = await page
      .locator('[data-testid="SideNav_AccountSwitcher_Button"]')
      .isVisible()
      .catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page
        .locator('input[autocomplete="username"]')
        .isVisible()
        .catch(() => false);
      if (onLoginPage) {
        return {
          success: false,
          message: 'X login expired. Run /x-integration to re-authenticate.',
        };
      }
    }

    await page
      .waitForSelector('article[data-testid="tweet"]', {
        timeout: config.timeouts.elementWait * 2,
      })
      .catch(() => null);

    // Scroll a few times to load author continuation rendered below the focal tweet
    for (let i = 0; i < 4; i++) {
      await page.evaluate(() => window.scrollBy(0, window.innerHeight));
      await page.waitForTimeout(1500);
    }
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(500);

    const tweets: TweetData[] = await page.evaluate(EXTRACT_TWEETS_JS);

    // Identify the focal tweet by ID match (URL may use canonical handle even
    // if input used /i/status/)
    const focalIdx = tweets.findIndex((t) => t.url && t.url.includes(`/status/${tweetId}`));
    if (focalIdx === -1) {
      await context.close();
      return {
        success: false,
        message: `Tweet ${tweetId} loaded but not found in extracted articles. Page may have changed.`,
      };
    }

    const focal = tweets[focalIdx];
    const author = focal.handle.toLowerCase();

    // Parent chain: tweets above focal that are the upward reply chain (author
    // varies). X renders parents directly above the focused tweet in order.
    const parentChain: TweetData[] = [];
    for (let i = 0; i < focalIdx; i++) {
      const t = tweets[i];
      if (!t.url || t.url === focal.url) continue;
      parentChain.push(t);
    }

    // Continuation: tweets BELOW the focal authored by the same handle.
    // X mixes other replies in too — filter to same author only.
    const continuation: TweetData[] = [];
    for (let i = focalIdx + 1; i < tweets.length; i++) {
      const t = tweets[i];
      if (!t.url || t.url === focal.url) continue;
      if (t.handle.toLowerCase() === author) continuation.push(t);
      if (continuation.length >= 20) break;
    }

    // Download media for focal + parent chain + continuation
    const allTweets = [...parentChain, focal, ...continuation];
    for (const t of allTweets) {
      const paths = await downloadTweetMedia(t);
      if (paths.length > 0) t.imagePaths = paths;
    }

    await context.close();

    const totalImages = allTweets.reduce(
      (sum, t) => sum + (t.imagePaths?.length || 0),
      0,
    );

    return {
      success: true,
      message: `Read tweet ${tweetId}: ${parentChain.length} parent + 1 focal + ${continuation.length} continuation, ${totalImages} images saved`,
      data: {
        focal,
        parent_chain: parentChain,
        continuation,
        media_dir: MEDIA_DIR,
      },
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      success: false,
      message: `read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

runScript(readTweet);
