#!/usr/bin/env tsx
/**
 * One-off: re-sync `post_date` in substack_feed_posts from corrected post.json
 * files in ~/git/account-data/data/substack/. Use after running
 * scripts/fix_substack_dates.py to repair date metadata.
 *
 * Matches rows by post_url. Idempotent.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import Database from 'better-sqlite3';

const DB_PATH = path.join(
  os.homedir(),
  'git',
  'nanoclaw',
  'store',
  'messages.db',
);
const ARCHIVE_ROOT = path.join(
  os.homedir(),
  'git',
  'account-data',
  'data',
  'substack',
);

const db = new Database(DB_PATH);
const update = db.prepare(
  'UPDATE substack_feed_posts SET post_date = ? WHERE post_url = ? AND (post_date IS NULL OR post_date != ?)',
);

let updated = 0;
let missing = 0;
let scanned = 0;

for (const pubDir of fs.readdirSync(ARCHIVE_ROOT)) {
  const pubPath = path.join(ARCHIVE_ROOT, pubDir);
  if (!fs.statSync(pubPath).isDirectory()) continue;
  for (const slug of fs.readdirSync(pubPath)) {
    const jsonPath = path.join(pubPath, slug, 'post.json');
    if (!fs.existsSync(jsonPath)) continue;
    scanned++;
    let meta: { url?: string; date?: string };
    try {
      meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    } catch {
      continue;
    }
    if (!meta.url || !meta.date) {
      missing++;
      continue;
    }
    const res = update.run(meta.date, meta.url, meta.date);
    if (res.changes > 0) updated++;
  }
}

console.log(`scanned=${scanned} updated=${updated} missing_url_or_date=${missing}`);
