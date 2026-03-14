/**
 * X Feed Monitor - Notification writer
 *
 * Writes IPC message files for the main nanoclaw process to pick up
 * and deliver via WhatsApp.
 */

import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { FilteredTweet } from './x-feed-filter.js';

/**
 * Send a direct WhatsApp notification about a matched tweet.
 */
export function notifyTweet(
  chatJid: string,
  tweet: FilteredTweet,
  groupFolder: string,
): void {
  const reasons = tweet.matchReasons.join(' | ');
  const author = tweet.handle || tweet.author;
  const preview =
    tweet.text.length > 280
      ? tweet.text.slice(0, 277) + '...'
      : tweet.text;

  const text = [
    `*X Signal* — ${author}`,
    '',
    preview,
    '',
    `_${reasons}_`,
    tweet.url,
  ].join('\n');

  writeIpcMessage(chatJid, text, groupFolder);
}

/**
 * Send a batch summary notification.
 */
export function notifyBatch(
  chatJid: string,
  tweets: FilteredTweet[],
  groupFolder: string,
): void {
  if (tweets.length === 0) return;

  if (tweets.length === 1) {
    notifyTweet(chatJid, tweets[0], groupFolder);
    return;
  }

  const lines = [`*X Signals* — ${tweets.length} new matches\n`];

  for (const tweet of tweets.slice(0, 10)) {
    const author = tweet.handle || tweet.author;
    const preview =
      tweet.text.length > 120
        ? tweet.text.slice(0, 117) + '...'
        : tweet.text;
    lines.push(`• *${author}*: ${preview}`);
    lines.push(`  _${tweet.matchReasons.join(' | ')}_`);
    lines.push(`  ${tweet.url}\n`);
  }

  if (tweets.length > 10) {
    lines.push(`...and ${tweets.length - 10} more`);
  }

  writeIpcMessage(chatJid, lines.join('\n'), groupFolder);
}

export function writeIpcMessage(
  chatJid: string,
  text: string,
  groupFolder: string,
): void {
  const messagesDir = path.join(DATA_DIR, 'ipc', groupFolder, 'messages');
  fs.mkdirSync(messagesDir, { recursive: true });

  const filename = `xfeed-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
  fs.writeFileSync(
    path.join(messagesDir, filename),
    JSON.stringify({ type: 'message', chatJid, text }),
  );
}
