/**
 * Substack Feed Monitor - Configuration
 *
 * Loads and hot-reloads config from data/substack-feed-config.yaml.
 */

import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { DATA_DIR } from './config.js';
import { logger } from './logger.js';

export interface SubstackFeedConfig {
  pollIntervalMs: number;
  maxScrolls: number;
  postCount: number;

  authFailureBackoffMs: number;
  browserRestartIntervalMs: number;
}

const CONFIG_PATH = path.join(DATA_DIR, 'substack-feed-config.yaml');

const DEFAULTS: SubstackFeedConfig = {
  pollIntervalMs: 1_800_000, // 30 minutes
  maxScrolls: 5,
  postCount: 20,

  authFailureBackoffMs: 900_000, // 15 minutes
  browserRestartIntervalMs: 12 * 60 * 60 * 1000, // 12 hours
};

let lastMtime = 0;
let cachedConfig: SubstackFeedConfig = { ...DEFAULTS };

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function loadConfig(): SubstackFeedConfig {
  if (!fs.existsSync(CONFIG_PATH)) {
    writeDefaultConfig();
    return { ...DEFAULTS };
  }

  try {
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    const parsed = YAML.parse(raw) || {};
    cachedConfig = { ...DEFAULTS, ...parsed };
    lastMtime = fs.statSync(CONFIG_PATH).mtimeMs;
    return cachedConfig;
  } catch (err) {
    logger.warn(
      { err, path: CONFIG_PATH },
      'Failed to parse config, using defaults',
    );
    return cachedConfig;
  }
}

export function reloadConfigIfChanged(): SubstackFeedConfig {
  try {
    const mtime = fs.statSync(CONFIG_PATH).mtimeMs;
    if (mtime > lastMtime) {
      logger.info('Config file changed, reloading');
      return loadConfig();
    }
  } catch {
    // File missing or inaccessible
  }
  return cachedConfig;
}

function writeDefaultConfig(): void {
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const yaml = YAML.stringify({
    ...DEFAULTS,
    _comment:
      'Edit this file to configure the Substack feed monitor. Changes are hot-reloaded.',
  });
  fs.writeFileSync(CONFIG_PATH, yaml);
  logger.info({ path: CONFIG_PATH }, 'Created default config');
}
