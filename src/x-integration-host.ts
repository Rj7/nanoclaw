/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * This is the entry point for X integration in the host process.
 */

import path from 'path';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';
import {
  runSkillScript,
  writeIpcResult,
  type SkillResult,
} from './skill-runner.js';
import {
  getXFeedAuthors,
  getXFeedMonitorHealth,
  getThreadChain,
  searchXFeedTweets,
} from './db.js';

// Host filesystem paths that show up in IPC results, mapped to the container
// paths the agent can actually Read. Agent never sees raw host paths.
const HOST_TO_CONTAINER_PATH: Array<[string, string]> = [
  [path.join(DATA_DIR, 'x-images'), '/workspace/x-images'],
  [path.join(DATA_DIR, 'cross-agent'), '/workspace/cross-agent'],
];

function translatePath(p: string | null | undefined): string | null {
  if (!p) return p ?? null;
  for (const [host, ctr] of HOST_TO_CONTAINER_PATH) {
    if (p.startsWith(host)) return ctr + p.slice(host.length);
  }
  return p;
}

function translateImagesField(images: string | null): string | null {
  if (!images) return images;
  return images
    .split(',')
    .map((s) => translatePath(s.trim()) ?? s)
    .join(',');
}

function translateFeedRow<T extends { images?: string | null }>(row: T): T {
  if (row.images) {
    return { ...row, images: translateImagesField(row.images) };
  }
  return row;
}

function translateReadResult(data: unknown): unknown {
  if (!data || typeof data !== 'object') return data;
  const d = data as {
    focal?: { imagePaths?: string[] };
    parent_chain?: Array<{ imagePaths?: string[] }>;
    continuation?: Array<{ imagePaths?: string[] }>;
    media_dir?: string;
  };
  const fix = (t: { imagePaths?: string[] } | undefined) => {
    if (!t || !t.imagePaths) return t;
    return {
      ...t,
      imagePaths: t.imagePaths.map((p) => translatePath(p) ?? p),
    };
  };
  return {
    ...d,
    focal: fix(d.focal),
    parent_chain: (d.parent_chain || []).map(fix),
    continuation: (d.continuation || []).map(fix),
    media_dir: translatePath(d.media_dir),
  };
}

/** X tool types that only read from the local DB — safe for non-main groups. */
const X_READ_ONLY_TYPES = new Set([
  'x_feed_query',
  'x_feed_authors',
  'x_thread',
]);

function runScript(script: string, args: object): Promise<SkillResult> {
  return runSkillScript('x-integration', script, args);
}

/**
 * Handle X integration IPC messages
 *
 * @returns true if message was handled, false if not an X message
 */
export async function handleXIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  // Only handle x_* types
  if (!type?.startsWith('x_')) {
    return false;
  }

  // Read-only feed queries are allowed for all groups; writes and live
  // browser actions are restricted to the main group.
  if (!isMain && !X_READ_ONLY_TYPES.has(type)) {
    logger.warn({ sourceGroup, type }, 'X integration blocked: not main group');
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'X integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing X request');

  let result: SkillResult;

  switch (type) {
    case 'x_post':
      if (!data.content) {
        result = { success: false, message: 'Missing content' };
        break;
      }
      result = await runScript('post', { content: data.content });
      break;

    case 'x_like':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('like', { tweetUrl: data.tweetUrl });
      break;

    case 'x_reply':
      if (!data.tweetUrl || !data.content) {
        result = { success: false, message: 'Missing tweetUrl or content' };
        break;
      }
      result = await runScript('reply', {
        tweetUrl: data.tweetUrl,
        content: data.content,
      });
      break;

    case 'x_retweet':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('retweet', { tweetUrl: data.tweetUrl });
      break;

    case 'x_quote':
      if (!data.tweetUrl || !data.comment) {
        result = { success: false, message: 'Missing tweetUrl or comment' };
        break;
      }
      result = await runScript('quote', {
        tweetUrl: data.tweetUrl,
        comment: data.comment,
      });
      break;

    case 'x_feed':
      result = await runScript('feed', { count: data.count || 20 });
      break;

    case 'x_search':
      if (!data.query) {
        result = { success: false, message: 'Missing query' };
        break;
      }
      result = await runScript('search', {
        query: data.query,
        count: data.count || 20,
      });
      break;

    case 'x_read':
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      result = await runScript('read', { tweet_url: data.tweetUrl });
      if (result.success && result.data) {
        result = { ...result, data: translateReadResult(result.data) };
      }
      break;

    case 'x_feed_query': {
      const tweets = searchXFeedTweets({
        ticker: data.ticker as string | undefined,
        author: data.author as string | undefined,
        keyword: data.keyword as string | undefined,
        sinceHours: (data.since_hours as number) || 24,
        limit: (data.limit as number) || 50,
      });

      // Always include monitor health so the agent has objective truth
      // about feed state and doesn't conflate "no matches for my filter"
      // with "monitor is down".
      const monitor = getXFeedMonitorHealth();
      const ageNote =
        monitor.ageMinutes !== null
          ? `last scrape ${monitor.ageMinutes}m ago`
          : 'no scrape history';
      const healthSummary = `Monitor: ${monitor.totalRows} total rows, ${ageNote}`;

      if (tweets.length > 0) {
        result = {
          success: true,
          message: `Found ${tweets.length} saved tweets. ${healthSummary}.`,
          data: tweets.map(translateFeedRow),
        };
      } else {
        const healthVerdict =
          monitor.ageMinutes !== null && monitor.ageMinutes <= 10
            ? '(monitor healthy)'
            : '(monitor may be stale — verify before assuming filter result is the issue)';
        result = {
          success: true,
          message: `No saved tweets matched the filter. ${healthSummary} ${healthVerdict}. This is "filter returned empty", NOT "feed is down". Adjust your filter (broader keyword/ticker/since_hours) or call x_search if you need content beyond what your home timeline scraped.`,
          data: [],
        };
      }
      break;
    }

    case 'x_thread': {
      if (!data.tweetUrl) {
        result = { success: false, message: 'Missing tweetUrl' };
        break;
      }
      const chain = getThreadChain(data.tweetUrl as string);
      result = {
        success: true,
        message:
          chain.length > 0
            ? `Thread chain: ${chain.length} tweets (root → leaf)`
            : 'Tweet not found in saved feed or no parent chain',
        data: chain.map(translateFeedRow),
      };
      break;
    }

    case 'x_feed_authors': {
      const authors = getXFeedAuthors({
        sinceHours: (data.since_hours as number) || undefined,
        search: data.search as string | undefined,
      });
      result = {
        success: true,
        message: `Found ${authors.length} authors`,
        data: authors,
      };
      break;
    }

    default:
      return false;
  }

  writeIpcResult(dataDir, sourceGroup, 'x_results', requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'X request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'X request failed',
    );
  }
  return true;
}
