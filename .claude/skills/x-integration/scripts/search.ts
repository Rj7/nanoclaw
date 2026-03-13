#!/usr/bin/env npx tsx
/**
 * X Integration - Search Posts
 * Usage: echo '{"query":"$AAOI","count":20}' | npx tsx search.ts
 */

import { getBrowserContext, runScript, collectTweets, config, ScriptResult } from '../lib/browser.js';

interface SearchInput {
  query: string;
  count: number;
}

async function searchX(input: SearchInput): Promise<ScriptResult> {
  if (!input.query) {
    return { success: false, message: 'Search query is required' };
  }

  const count = Math.min(Math.max(input.count || 20, 1), 50);
  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    const searchUrl = `https://x.com/search?q=${encodeURIComponent(input.query)}&src=typed_query&f=live`;
    await page.goto(searchUrl, { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.timeouts.pageLoad);

    // Check if logged in
    const isLoggedIn = await page.locator('[data-testid="SideNav_AccountSwitcher_Button"]').isVisible().catch(() => false);
    if (!isLoggedIn) {
      const onLoginPage = await page.locator('input[autocomplete="username"]').isVisible().catch(() => false);
      if (onLoginPage) {
        return { success: false, message: 'X login expired. Run /x-integration to re-authenticate.' };
      }
    }

    await page.waitForSelector('article[data-testid="tweet"]', { timeout: config.timeouts.elementWait * 2 }).catch(() => null);

    const allTweets = await collectTweets(page, count);
    await context.close();

    return {
      success: true,
      message: `Found ${allTweets.length} posts for "${input.query}"`,
      data: { posts: allTweets },
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      success: false,
      message: `Search failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

runScript(searchX);
