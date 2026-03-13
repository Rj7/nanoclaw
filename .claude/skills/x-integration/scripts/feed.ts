#!/usr/bin/env npx tsx
/**
 * X Integration - Read Home Feed
 * Usage: echo '{"count":20}' | npx tsx feed.ts
 */

import { getBrowserContext, runScript, collectTweets, config, ScriptResult } from '../lib/browser.js';

interface FeedInput {
  count: number;
}

async function readFeed(input: FeedInput): Promise<ScriptResult> {
  const count = Math.min(Math.max(input.count || 20, 1), 50);
  let context = null;

  try {
    context = await getBrowserContext();
    const page = context.pages()[0] || await context.newPage();

    await page.goto('https://x.com/home', { timeout: config.timeouts.navigation, waitUntil: 'domcontentloaded' });
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
      message: `Retrieved ${allTweets.length} posts from your home feed`,
      data: { posts: allTweets },
    };
  } catch (err) {
    if (context) await context.close().catch(() => {});
    return {
      success: false,
      message: `Failed to read feed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

runScript(readFeed);
