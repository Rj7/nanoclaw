import path from 'path';

const PROJECT_ROOT = process.env.NANOCLAW_ROOT || process.cwd();

export const config = {
  chromePath: process.env.CHROME_PATH || (process.platform === 'darwin'
    ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
    : '/usr/bin/google-chrome'),
  browserDataDir: path.join(PROJECT_ROOT, 'data', 'substack-browser-profile'),
  authPath: path.join(PROJECT_ROOT, 'data', 'substack-browser-auth.json'),
  viewport: { width: 1280, height: 800 },
  timeouts: {
    navigation: 30000,
    elementWait: 8000,
    afterClick: 1000,
    pageLoad: 5000,
  },
  chromeArgs: [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-sync',
  ],
  chromeIgnoreDefaultArgs: ['--enable-automation'],
};
