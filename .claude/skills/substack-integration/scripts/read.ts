#!/usr/bin/env npx tsx
/**
 * Substack Integration - Read Article
 * Usage: echo '{"url":"https://example.substack.com/p/article-slug"}' | npx tsx read.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface ReadInput {
  url: string;
}

async function readArticle(input: ReadInput): Promise<ScriptResult> {
  if (!input.url) {
    return { success: false, message: 'Article URL is required' };
  }

  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto(input.url, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check for paywall/login redirect
    const currentUrl = page.url();
    if (currentUrl.includes('sign-in') || currentUrl.includes('login')) {
      await context.close();
      return { success: false, message: 'Substack login expired. Need to re-authenticate browser session.' };
    }

    // Wait for article body
    await page.waitForSelector('.body.markup, .available-content, article .post-content, [class*="body"]', {
      timeout: config.timeouts.elementWait,
    }).catch(() => null);

    const article = await page.evaluate(() => {
      // Title
      const titleEl = document.querySelector('h1.post-title, h1[class*="post-title"], article h1, .post-header h1');
      const title = titleEl?.textContent?.trim() || document.title;

      // Author
      const authorEl = document.querySelector('.author-name, [class*="byline"] a, .post-header a[href*="/@"], .pencraft [class*="author"]');
      const author = authorEl?.textContent?.trim() || '';

      // Publication
      const pubEl = document.querySelector('.publication-name, [class*="pub-name"], a[class*="publication"]');
      const publication = pubEl?.textContent?.trim() || '';

      // Date
      const dateEl = document.querySelector('.post-date, time, [class*="date"]');
      const date = dateEl?.textContent?.trim() || dateEl?.getAttribute('datetime') || '';

      // Article body — try multiple selectors
      const bodyEl = document.querySelector('.body.markup, .available-content, .post-content, article [class*="body"]');

      let content = '';
      if (bodyEl) {
        // Walk through child elements to preserve structure
        const blocks = bodyEl.querySelectorAll('p, h2, h3, h4, li, blockquote, pre');
        const parts: string[] = [];
        for (const block of blocks) {
          const tag = block.tagName.toLowerCase();
          const text = block.textContent?.trim() || '';
          if (!text) continue;

          if (tag.startsWith('h')) {
            parts.push(`\n## ${text}\n`);
          } else if (tag === 'blockquote') {
            parts.push(`> ${text}`);
          } else if (tag === 'li') {
            parts.push(`- ${text}`);
          } else if (tag === 'pre') {
            parts.push(`\`\`\`\n${text}\n\`\`\``);
          } else {
            parts.push(text);
          }
        }
        content = parts.join('\n\n');
      }

      // Check for paywall
      const paywallEl = document.querySelector('[class*="paywall"], [class*="subscribe-prompt"]');
      const isPaywalled = !!paywallEl && content.length < 500;

      const wordCount = content.split(/\s+/).filter(Boolean).length;

      return { title, author, publication, date, content, wordCount, isPaywalled };
    });

    await context.close();

    if (article.isPaywalled) {
      return {
        success: false,
        message: `Article "${article.title}" is paywalled and your subscription may not cover it. Partial content returned.`,
        data: article,
      };
    }

    // Truncate very long articles
    const maxChars = 50000;
    if (article.content.length > maxChars) {
      article.content = article.content.slice(0, maxChars) + '\n\n[... truncated — article too long]';
    }

    return {
      success: true,
      message: `Read article: ${article.title} (${article.wordCount} words)`,
      data: article,
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      success: false,
      message: `Failed to read article: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

runScript(readArticle);
