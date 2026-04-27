import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(
  process.env.IDLE_TIMEOUT || '10800000',
  10,
); // 3hr default — how long to keep container alive after last result
export const MAX_TASK_DURATION_MS = parseInt(
  process.env.MAX_TASK_DURATION_MS || '900000',
  10,
); // 15min default — non-resetting wall-clock cap for scheduled tasks
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Per-group trigger (e.g. "@ari"). Each registered group has its own
// trigger_pattern; the global TRIGGER_PATTERN above is only the fallback
// for the primary assistant.
export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger)}\\b`, 'i');
}

// Native channel mention of the bot itself, e.g. WhatsApp's "@<phone>" or
// "@<lid>" tap-to-mention. Matches anywhere in the message (mentions can
// be mid-sentence, unlike the leading @-trigger).
export function buildSelfMentionPattern(ids: string[]): RegExp | null {
  const cleaned = ids.filter((id) => /^\d+$/.test(id));
  if (cleaned.length === 0) return null;
  return new RegExp(`(?:^|\\s)@(?:${cleaned.join('|')})\\b`);
}

// Feed health monitor: alert if no new data collected within these windows
export const FEED_HEALTH_CHECK_INTERVAL = 30 * 60 * 1000; // 30 minutes
export const X_FEED_STALE_THRESHOLD_MS = 6 * 60 * 60 * 1000; // 6 hours
export const SUBSTACK_FEED_STALE_THRESHOLD_MS = 48 * 60 * 60 * 1000; // 48 hours

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
