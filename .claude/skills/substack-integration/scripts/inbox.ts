#!/usr/bin/env npx tsx
/**
 * Substack Integration - Read Subscription Inbox
 * Usage: echo '{"count":15}' | npx tsx inbox.ts
 */

import { getBrowserContext, runScript, config, ScriptResult } from '../lib/browser.js';

interface InboxInput {
  count: number;
}

interface SubstackPost {
  title: string;
  author: string;
  publication: string;
  url: string;
  date: string;
  snippet: string;
}

async function readInbox(input: InboxInput): Promise<ScriptResult> {
  const count = Math.min(Math.max(input.count || 15, 1), 30);
  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://substack.com/inbox', { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if logged in — inbox redirects to sign-in if not
    const currentUrl = page.url();
    if (currentUrl.includes('sign-in') || currentUrl.includes('login')) {
      await context.close();
      return { success: false, message: 'Substack login expired. Need to re-authenticate browser session.' };
    }

    // Wait for inbox content
    await page.waitForSelector('[class*="reader-nav-feed"], [class*="inbox"], article, .post-preview', {
      timeout: config.timeouts.elementWait,
    }).catch(() => null);

    const allPosts: SubstackPost[] = [];
    const seenUrls = new Set<string>();
    let scrollRounds = 0;
    const maxScrolls = 5;

    while (allPosts.length < count && scrollRounds < maxScrolls) {
      // Extract posts — Substack inbox uses various card/article layouts
      const posts = await page.evaluate(() => {
        const results: Array<{
          title: string;
          author: string;
          publication: string;
          url: string;
          date: string;
          snippet: string;
        }> = [];

        // Try multiple selectors for Substack inbox items
        const items = document.querySelectorAll(
          'article, [class*="post-preview"], [class*="inbox-item"], .reader2-post-preview, div[data-testid="inbox-post"]'
        );

        for (const item of items) {
          // Find the title link
          const titleEl = item.querySelector('a[data-testid="post-preview-title"], h2 a, h3 a, [class*="post-preview-title"] a, a[class*="title"]');
          const title = titleEl?.textContent?.trim() || '';
          const url = titleEl?.getAttribute('href') || '';

          if (!title || !url) continue;

          // Author/publication
          const pubEl = item.querySelector('[class*="publication-name"], [class*="pub-name"], [class*="byline"] a, .pencraft a');
          const publication = pubEl?.textContent?.trim() || '';

          const authorEl = item.querySelector('[class*="author"], [class*="byline"]');
          const author = authorEl?.textContent?.trim().replace(/^by\s+/i, '') || publication;

          // Date
          const dateEl = item.querySelector('time, [class*="date"], [class*="time"]');
          const date = dateEl?.textContent?.trim() || dateEl?.getAttribute('datetime') || '';

          // Snippet/preview
          const snippetEl = item.querySelector('[class*="subtitle"], [class*="preview-text"], [class*="body"], p');
          const snippet = snippetEl?.textContent?.trim().slice(0, 200) || '';

          results.push({
            title,
            author,
            publication,
            url: url.startsWith('http') ? url : `https://substack.com${url}`,
            date,
            snippet,
          });
        }

        return results;
      });

      for (const post of posts) {
        if (!seenUrls.has(post.url)) {
          seenUrls.add(post.url);
          allPosts.push(post);
          if (allPosts.length >= count) break;
        }
      }

      if (allPosts.length >= count) break;

      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(2000);
      scrollRounds++;
    }

    await context.close();

    return {
      success: true,
      message: `Retrieved ${allPosts.length} posts from your Substack inbox`,
      data: { posts: allPosts },
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      success: false,
      message: `Failed to read inbox: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

runScript(readInbox);
