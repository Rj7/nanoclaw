#!/usr/bin/env tsx
/**
 * Backfill the substack_feed_posts table from ~/git/account-data/data/substack/.
 *
 * Walks each <publication>/<slug>/post.json, maps to SubstackFeedPostRow,
 * copies images to ~/git/nanoclaw/data/substack-images/<slug>/, and inserts
 * via saveSubstackFeedPostsBatch (INSERT OR IGNORE — safe to re-run).
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  initDatabase,
  saveSubstackFeedPostsBatch,
  SubstackFeedPostRow,
} from '../src/db.js';

const ARCHIVE_ROOT = path.join(
  os.homedir(),
  'git',
  'account-data',
  'data',
  'substack',
);
const IMAGES_ROOT = path.join(
  os.homedir(),
  'git',
  'nanoclaw',
  'data',
  'substack-images',
);

const PUB_NAME: Record<string, string> = {
  jasonschips: "Jason's Chips",
  semianalysis: 'SemiAnalysis',
  citrini: 'Citrini Research',
  'ahead-of-ai': 'Ahead of AI',
  'exploring-lms': 'Exploring Language Models',
  globalsemiresearch: 'Global Semi Research',
  photoncap: 'PhotonCap',
};

interface PostJson {
  slug: string;
  url: string;
  title: string;
  subtitle?: string;
  date?: string;
  content?: string;
  is_paywalled?: boolean;
  word_count?: number;
  image_count?: number;
}

function readPostMd(postDir: string): string | null {
  const mdPath = path.join(postDir, 'post.md');
  if (!fs.existsSync(mdPath)) return null;
  const raw = fs.readFileSync(mdPath, 'utf8');
  return raw.replace(/^---[\s\S]*?---\n+/, '');
}

function copyImages(srcDir: string, slug: string): string[] {
  if (!fs.existsSync(srcDir)) return [];
  const destDir = path.join(IMAGES_ROOT, slug);
  fs.mkdirSync(destDir, { recursive: true });
  const out: string[] = [];
  const files = fs.readdirSync(srcDir);
  for (const f of files) {
    const srcFile = path.join(srcDir, f);
    const destFile = path.join(destDir, f);
    if (!fs.existsSync(destFile)) {
      fs.copyFileSync(srcFile, destFile);
    }
    out.push(destFile);
  }
  return out;
}

function buildSnippet(content: string): string {
  const cleaned = content.replace(/\s+/g, ' ').trim();
  return cleaned.slice(0, 300);
}

async function main() {
  initDatabase();
  if (!fs.existsSync(ARCHIVE_ROOT)) {
    console.error(`Archive root not found: ${ARCHIVE_ROOT}`);
    process.exit(1);
  }

  const rows: SubstackFeedPostRow[] = [];
  let skipped = 0;
  let copiedImages = 0;

  for (const pubDir of fs.readdirSync(ARCHIVE_ROOT)) {
    const pubName = PUB_NAME[pubDir];
    if (!pubName) {
      console.warn(`No publication mapping for: ${pubDir} — skipping folder`);
      continue;
    }
    const pubPath = path.join(ARCHIVE_ROOT, pubDir);
    if (!fs.statSync(pubPath).isDirectory()) continue;

    for (const slug of fs.readdirSync(pubPath)) {
      const postDir = path.join(pubPath, slug);
      const jsonPath = path.join(postDir, 'post.json');
      if (!fs.existsSync(jsonPath)) continue;

      let meta: PostJson;
      try {
        meta = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      } catch (e) {
        console.warn(`Failed to parse ${jsonPath}: ${e}`);
        skipped++;
        continue;
      }

      const mdBody = readPostMd(postDir);
      const content = mdBody || meta.content || '';
      if (!content) {
        skipped++;
        continue;
      }

      const imageFiles = copyImages(path.join(postDir, 'images'), slug);
      copiedImages += imageFiles.length;

      const stat = fs.statSync(jsonPath);
      const row: SubstackFeedPostRow = {
        post_url: meta.url,
        title: meta.title || slug,
        author: pubName,
        publication: pubName,
        snippet: buildSnippet(content),
        content,
        images: imageFiles.length ? JSON.stringify(imageFiles) : null,
        word_count: meta.word_count ?? content.split(/\s+/).length,
        post_date: meta.date || null,
        collected_at: stat.mtime.toISOString(),
      };
      rows.push(row);
    }
  }

  console.log(`Prepared ${rows.length} rows (${skipped} skipped, ${copiedImages} images copied)`);
  const inserted = saveSubstackFeedPostsBatch(rows);
  console.log(`Inserted ${inserted} new rows (${rows.length - inserted} already in DB)`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
