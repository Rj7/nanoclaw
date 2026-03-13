#!/usr/bin/env npx tsx
/**
 * Substack Integration - Browser Login Setup
 * Launches a visible Chrome window for the user to log in to Substack.
 * After login, saves the browser session for future use.
 *
 * Usage: npx tsx setup.ts
 */

import { chromium } from 'playwright';
import fs from 'fs';
import { config } from '../lib/config.js';

async function setup() {
  console.log('Starting Substack browser login...');
  console.log(`Browser profile: ${config.browserDataDir}`);
  console.log('');

  // Clean up lock files
  for (const lockFile of ['SingletonLock', 'SingletonSocket', 'SingletonCookie']) {
    const lockPath = `${config.browserDataDir}/${lockFile}`;
    if (fs.existsSync(lockPath)) {
      try { fs.unlinkSync(lockPath); } catch {}
    }
  }

  fs.mkdirSync(config.browserDataDir, { recursive: true });

  const context = await chromium.launchPersistentContext(config.browserDataDir, {
    executablePath: config.chromePath,
    headless: false,
    viewport: config.viewport,
    args: config.chromeArgs,
    ignoreDefaultArgs: config.chromeIgnoreDefaultArgs,
  });

  const page = context.pages()[0] || await context.newPage();
  await page.goto('https://substack.com/sign-in', { waitUntil: 'domcontentloaded' });

  console.log('A Chrome window has opened at substack.com/sign-in');
  console.log('Please log in to your Substack account.');
  console.log('');
  console.log('After logging in, navigate to https://substack.com/inbox');
  console.log('Once you see your inbox, press Enter here to save the session...');

  // Wait for user to press Enter
  await new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });

  // Verify login by checking current URL
  const currentUrl = page.url();
  const isLoggedIn = !currentUrl.includes('sign-in') && !currentUrl.includes('login');

  if (isLoggedIn) {
    fs.writeFileSync(config.authPath, JSON.stringify({
      authenticated: true,
      timestamp: new Date().toISOString(),
      profile: config.browserDataDir,
    }));
    console.log('Substack browser session saved successfully!');
  } else {
    console.log('WARNING: It looks like you may not be logged in yet.');
    console.log('The session was saved anyway — try running substack_inbox to test.');
    fs.writeFileSync(config.authPath, JSON.stringify({
      authenticated: false,
      timestamp: new Date().toISOString(),
      profile: config.browserDataDir,
    }));
  }

  await context.close();
}

setup().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
