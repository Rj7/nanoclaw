/**
 * Substack Integration IPC Handler
 *
 * Handles substack_* IPC messages from container agents.
 * Uses Playwright on the host with a persistent browser profile.
 */

import { searchSubstackFeedPosts, getSubstackFeedPublications } from './db.js';
import { logger } from './logger.js';
import {
  runSkillScript,
  writeIpcResult,
  type SkillResult,
} from './skill-runner.js';

function runScript(script: string, args: object): Promise<SkillResult> {
  return runSkillScript('substack-integration', script, args);
}

/** Substack tools that only read from the local DB — safe for non-main groups. */
const SUBSTACK_READ_ONLY_TYPES = new Set([
  'substack_feed_query',
  'substack_feed_publications',
]);

export async function handleSubstackIpc(
  data: Record<string, unknown>,
  sourceGroup: string,
  isMain: boolean,
  dataDir: string,
): Promise<boolean> {
  const type = data.type as string;

  if (!type?.startsWith('substack_')) {
    return false;
  }

  if (!isMain && !SUBSTACK_READ_ONLY_TYPES.has(type)) {
    logger.warn(
      { sourceGroup, type },
      'Substack integration blocked: not main group',
    );
    return true;
  }

  const requestId = data.requestId as string;
  if (!requestId) {
    logger.warn({ type }, 'Substack integration blocked: missing requestId');
    return true;
  }

  logger.info({ type, requestId }, 'Processing Substack request');

  let result: SkillResult;

  switch (type) {
    case 'substack_inbox':
      result = await runScript('inbox', { count: data.count || 15 });
      break;

    case 'substack_read':
      if (!data.url) {
        result = { success: false, message: 'Missing url' };
        break;
      }
      result = await runScript('read', { url: data.url });
      break;

    case 'substack_feed_query': {
      const posts = searchSubstackFeedPosts({
        author: data.author as string | undefined,
        publication: data.publication as string | undefined,
        keyword: data.keyword as string | undefined,
        sinceHours: (data.since_hours as number) || 168,
        limit: (data.limit as number) || 50,
      });
      if (posts.length > 0) {
        result = {
          success: true,
          message: `Found ${posts.length} posts`,
          data: { posts },
        };
      } else {
        // Fall back to on-demand inbox if no stored posts match
        logger.info(
          { requestId },
          'No stored posts match, falling back to live inbox',
        );
        result = await runScript('inbox', { count: data.limit || 15 });
      }
      break;
    }

    case 'substack_feed_publications': {
      const pubs = getSubstackFeedPublications({
        sinceHours: (data.since_hours as number) || undefined,
        search: data.search as string | undefined,
      });
      result = {
        success: true,
        message: `Found ${pubs.length} publications`,
        data: { publications: pubs },
      };
      break;
    }

    default:
      return false;
  }

  writeIpcResult(dataDir, sourceGroup, 'substack_results', requestId, result);
  if (result.success) {
    logger.info({ type, requestId }, 'Substack request completed');
  } else {
    logger.error(
      { type, requestId, message: result.message },
      'Substack request failed',
    );
  }
  return true;
}
