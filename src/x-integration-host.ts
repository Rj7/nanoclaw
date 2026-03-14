/**
 * X Integration IPC Handler
 *
 * Handles all x_* IPC messages from container agents.
 * This is the entry point for X integration in the host process.
 */

import { logger } from './logger.js';
import {
  runSkillScript,
  writeIpcResult,
  type SkillResult,
} from './skill-runner.js';
import { searchXFeedTweets, getXFeedAuthors } from './db.js';

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

  // Only main group can use X integration
  if (!isMain) {
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

    case 'x_feed_query': {
      const tweets = searchXFeedTweets({
        ticker: data.ticker as string | undefined,
        author: data.author as string | undefined,
        keyword: data.keyword as string | undefined,
        sinceHours: (data.since_hours as number) || 24,
        limit: (data.limit as number) || 50,
      });

      if (tweets.length > 0) {
        result = {
          success: true,
          message: `Found ${tweets.length} saved tweets`,
          data: tweets,
        };
      } else {
        // Fallback: fetch live from X using the authenticated browser session
        logger.info({ requestId }, 'No saved tweets found, fetching live feed');
        const liveResult = await runScript('feed', {
          count: (data.limit as number) || 20,
        });
        if (liveResult.success) {
          result = {
            success: true,
            message:
              'No saved tweets matched. Fetched live feed instead (feed monitor may not be running).',
            data: liveResult.data,
          };
        } else {
          result = {
            success: true,
            message:
              'No saved tweets matched and live fetch failed. Is the feed monitor or X browser session active?',
            data: [],
          };
        }
      }
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
