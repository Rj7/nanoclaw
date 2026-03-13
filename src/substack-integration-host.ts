/**
 * Substack Integration IPC Handler
 *
 * Handles substack_* IPC messages from container agents.
 * Uses Playwright on the host with a persistent browser profile.
 */

import { logger } from './logger.js';
import {
  runSkillScript,
  writeIpcResult,
  type SkillResult,
} from './skill-runner.js';

function runScript(script: string, args: object): Promise<SkillResult> {
  return runSkillScript('substack-integration', script, args);
}

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

  if (!isMain) {
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
