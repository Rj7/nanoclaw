/**
 * Substack Feed Monitor - Persistent browser manager
 *
 * Keeps a single Chromium context alive for repeated polling.
 * Uses a SEPARATE browser profile from the on-demand Substack tools
 * to avoid Chrome lock contention.
 */

import fs from 'fs';
import path from 'path';

import { chromium, BrowserContext, Page } from 'playwright';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

const BROWSER_DATA_DIR = path.join(DATA_DIR, 'substack-feed-browser-profile');
const AUTH_PATH = path.join(DATA_DIR, 'substack-feed-auth.json');

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

// Extraction JS as a string to avoid tsx __name injection in browser context
export const EXTRACT_POSTS_JS = `(function() {
  var posts = document.querySelectorAll('a.reader2-inbox-post');
  var results = [];
  for (var i = 0; i < posts.length; i++) {
    var post = posts[i];
    var href = post.getAttribute('href') || '';
    if (!href || href.indexOf('/p/') === -1) continue;
    var pubEl = post.querySelector('.pub-name');
    var publication = pubEl ? pubEl.textContent.trim() : '';
    var titleEl = post.querySelector('.reader2-post-title');
    var title = titleEl ? titleEl.textContent.trim() : '';
    if (!title) continue;
    var snippetEl = post.querySelector('.reader2-paragraph');
    var snippet = snippetEl ? snippetEl.textContent.trim().slice(0, 200) : '';
    var metaEl = post.querySelector('.reader2-item-meta');
    var metaText = metaEl ? metaEl.textContent.trim() : '';
    var headChildren = post.querySelector('.reader2-post-head');
    var dateText = '';
    if (headChildren && headChildren.children.length >= 3) {
      dateText = headChildren.children[2].textContent.trim();
    }
    var url = href.indexOf('http') === 0 ? href : 'https://substack.com' + href;
    url = url.split('?')[0];
    results.push({
      title: title,
      author: publication,
      publication: publication,
      url: url,
      postDate: dateText,
      snippet: snippet
    });
  }
  return results;
})()`;

export interface SubstackPostData {
  title: string;
  author: string;
  publication: string;
  url: string;
  postDate: string;
  snippet: string;
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

  logger.info('Substack browser launched (persistent context)');
}

export async function getPage(): Promise<Page> {
  if (!context) throw new Error('Browser not launched');
  return context.pages()[0] || (await context.newPage());
}

export async function checkLogin(page: Page): Promise<boolean> {
  const url = page.url();
  return !url.includes('sign-in') && !url.includes('login');
}

export async function collectPosts(
  page: Page,
  count: number,
  maxScrolls: number,
): Promise<SubstackPostData[]> {
  const allPosts: SubstackPostData[] = [];
  const seenUrls = new Set<string>();
  let scrollRounds = 0;

  while (allPosts.length < count && scrollRounds < maxScrolls) {
    const posts: SubstackPostData[] = await page.evaluate(EXTRACT_POSTS_JS);

    for (const post of posts) {
      if (post.url && !seenUrls.has(post.url) && post.title) {
        seenUrls.add(post.url);
        allPosts.push(post);
        if (allPosts.length >= count) break;
      }
    }

    if (allPosts.length >= count) break;

    await page.evaluate('window.scrollBy(0, window.innerHeight * 2)');
    await page.waitForTimeout(2000);
    scrollRounds++;
  }

  return allPosts;
}

// Extraction JS for full article content + images
const EXTRACT_ARTICLE_JS = `(function() {
  var titleEl = document.querySelector('h1.post-title, h1[class*="post-title"], article h1, .post-header h1');
  var title = titleEl ? titleEl.textContent.trim() : document.title;
  var bodyEl = document.querySelector('.body.markup, .available-content, .post-content, article [class*="body"]');
  var content = '';
  var images = [];
  if (bodyEl) {
    var blocks = bodyEl.querySelectorAll('p, h2, h3, h4, li, blockquote, pre, figure img, .captioned-image-container img');
    var parts = [];
    for (var i = 0; i < blocks.length; i++) {
      var block = blocks[i];
      var tag = block.tagName.toLowerCase();
      if (tag === 'img') {
        var src = block.getAttribute('src') || '';
        if (src && src.indexOf('substackcdn') !== -1) {
          images.push(src);
          parts.push('[image: ' + (block.getAttribute('alt') || 'image') + ']');
        }
        continue;
      }
      var text = block.textContent ? block.textContent.trim() : '';
      if (!text) continue;
      if (tag.charAt(0) === 'h') {
        parts.push('\\n## ' + text + '\\n');
      } else if (tag === 'blockquote') {
        parts.push('> ' + text);
      } else if (tag === 'li') {
        parts.push('- ' + text);
      } else if (tag === 'pre') {
        parts.push('\\x60\\x60\\x60\\n' + text + '\\n\\x60\\x60\\x60');
      } else {
        parts.push(text);
      }
    }
    content = parts.join('\\n\\n');
    var imgEls = bodyEl.querySelectorAll('img');
    for (var j = 0; j < imgEls.length; j++) {
      var imgSrc = imgEls[j].getAttribute('src') || '';
      if (imgSrc && imgSrc.indexOf('substackcdn') !== -1 && images.indexOf(imgSrc) === -1) {
        images.push(imgSrc);
      }
    }
  }
  var wordCount = content.split(/\\s+/).filter(Boolean).length;
  return { title: title, content: content, images: images, wordCount: wordCount };
})()`;

export interface ArticleData {
  title: string;
  content: string;
  images: string[];
  wordCount: number;
}

export async function readArticle(
  page: Page,
  url: string,
): Promise<ArticleData | null> {
  try {
    await page.goto(url, { timeout: 30000, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000);

    // Wait for article body
    await page
      .waitForSelector(
        '.body.markup, .available-content, .post-content, article [class*="body"]',
        { timeout: 8000 },
      )
      .catch(() => null);

    const article: ArticleData = await page.evaluate(EXTRACT_ARTICLE_JS);

    // Truncate very long articles
    if (article.content.length > 50000) {
      article.content = article.content.slice(0, 50000) + '\n\n[... truncated]';
    }

    return article;
  } catch (err) {
    logger.warn({ err, url }, 'Failed to read article');
    return null;
  }
}

export async function close(): Promise<void> {
  if (context) {
    await context.close().catch(() => {});
    context = null;
    logger.info('Substack browser closed');
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
