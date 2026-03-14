#!/usr/bin/env npx tsx
/**
 * X Feed Monitor - Browser Login Setup
 *
 * Launches a visible Chrome window using the feed monitor's SEPARATE
 * browser profile (not the on-demand X tools profile) for the user
 * to log in to X.
 *
 * Usage: npx tsx src/x-feed-setup.ts
 */

import fs from 'fs';
import * as browser from './x-feed-browser.js';

async function setup() {
  console.log('X Feed Monitor — Browser Login Setup');
  console.log(`Browser profile: ${browser.getBrowserDataDir()}`);
  console.log('');

  await browser.launch();
  const page = await browser.getPage();
  await page.goto('https://x.com/login', { waitUntil: 'domcontentloaded' });

  console.log('A Chrome window has opened at x.com/login');
  console.log('Please log in to your X account.');
  console.log('');
  console.log('After logging in, navigate to https://x.com/home');
  console.log(
    'Once you see your feed, press Enter here to save the session...',
  );

  await new Promise<void>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', () => resolve());
  });

  const isLoggedIn = await browser.checkLogin(page);

  fs.writeFileSync(
    browser.getAuthPath(),
    JSON.stringify({
      authenticated: isLoggedIn,
      timestamp: new Date().toISOString(),
      profile: browser.getBrowserDataDir(),
    }),
  );

  if (isLoggedIn) {
    console.log('X feed monitor browser session saved successfully!');
    console.log('Start the monitor with: npm run x-feed-monitor');
  } else {
    console.log('WARNING: It looks like you may not be logged in yet.');
    console.log(
      'The session was saved anyway — try starting the monitor to test.',
    );
  }

  await browser.close();
}

setup().catch((err) => {
  console.error('Setup failed:', err.message);
  process.exit(1);
});
