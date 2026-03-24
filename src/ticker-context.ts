import fs from 'fs';
import os from 'os';
import path from 'path';

const VAULT_TICKERS_DIR = path.join(
  os.homedir(),
  'Obsidian',
  'Vault',
  'shared',
  'tickers',
);

let cachedPageNames: Set<string> | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000; // refresh directory listing every 60s

function getExistingPages(): Set<string> {
  const now = Date.now();
  if (cachedPageNames && now - cacheTime < CACHE_TTL_MS) {
    return cachedPageNames;
  }
  try {
    cachedPageNames = new Set(
      fs
        .readdirSync(VAULT_TICKERS_DIR)
        .filter((f) => f.endsWith('.md'))
        .map((f) => f.replace('.md', '')),
    );
    cacheTime = now;
  } catch {
    cachedPageNames = new Set();
  }
  return cachedPageNames;
}

/**
 * Extract ticker symbols from message text (case-insensitive).
 * Matches $ticker patterns and bare words that match vault page filenames.
 */
export function extractTickers(text: string): string[] {
  const tickers = new Set<string>();
  const existingPages = getExistingPages();

  // $TICKER patterns (explicit references, case-insensitive)
  const dollarMatches = text.matchAll(/\$([A-Za-z]{2,6})\b/g);
  for (const m of dollarMatches) {
    tickers.add(m[1].toUpperCase());
  }

  // Bare words that match existing vault pages (case-insensitive)
  const wordMatches = text.matchAll(/\b([A-Za-z]{2,6})\b/g);
  for (const m of wordMatches) {
    const upper = m[1].toUpperCase();
    if (existingPages.has(upper)) {
      tickers.add(upper);
    }
  }

  return Array.from(tickers);
}

/**
 * Load ticker pages from the vault and format as agent context.
 * Returns empty string if no tickers found or no pages exist.
 */
export function loadTickerContext(tickers: string[]): string {
  if (tickers.length === 0) return '';

  const sections: string[] = [];

  // Cap at 5 pages to avoid bloating context
  for (const ticker of tickers.slice(0, 5)) {
    const filePath = path.join(VAULT_TICKERS_DIR, `${ticker}.md`);
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      sections.push(
        `<ticker_reference symbol="${ticker}">\n${content}\n</ticker_reference>`,
      );
    } catch {
      // Page doesn't exist or unreadable, skip
    }
  }

  if (sections.length === 0) return '';

  return [
    '',
    '---',
    'VAULT TICKER PAGES (your accumulated research — use as context, do not repeat verbatim):',
    sections.join('\n\n'),
    '---',
  ].join('\n');
}
