/**
 * Feed Health Monitor
 *
 * Periodically checks whether the X and Substack feed monitors are
 * collecting data. Sends a WhatsApp alert if either feed goes stale.
 * Deduplicates alerts using router_state flags.
 */

import {
  FEED_HEALTH_CHECK_INTERVAL,
  X_FEED_STALE_THRESHOLD_MS,
  SUBSTACK_FEED_STALE_THRESHOLD_MS,
} from './config.js';
import {
  getLatestCollectedAt,
  getRouterState,
  setRouterState,
} from './db.js';
import { logger } from './logger.js';

export interface FeedHealthDeps {
  sendAlert: (text: string) => Promise<void>;
}

interface FeedCheckOpts {
  name: string;
  serviceName: string;
  getLatest: () => string | null;
  thresholdMs: number;
  alertKey: string;
  now: number;
  sendAlert: (text: string) => Promise<void>;
}

async function checkFeed(opts: FeedCheckOpts): Promise<void> {
  const latest = opts.getLatest();
  const alreadyAlerted = getRouterState(opts.alertKey) === 'true';

  if (!latest) {
    // No data at all — monitor may not have run yet. Don't alert.
    return;
  }

  const ageMs = opts.now - new Date(latest).getTime();
  const isStale = ageMs > opts.thresholdMs;

  if (isStale && !alreadyAlerted) {
    const hours = Math.round(ageMs / 3600000);
    const message = `⚠️ ${opts.name} monitor appears stale — no new data in ${hours}h. Check \`systemctl --user status ${opts.serviceName}\`.`;
    try {
      await opts.sendAlert(message);
      setRouterState(opts.alertKey, 'true');
      logger.warn(
        { feed: opts.name, ageHours: hours },
        'Feed health alert sent',
      );
    } catch (err) {
      logger.error({ err, feed: opts.name }, 'Failed to send feed health alert');
    }
  } else if (!isStale && alreadyAlerted) {
    setRouterState(opts.alertKey, '');
    logger.info({ feed: opts.name }, 'Feed health recovered, alert cleared');
  }
}

let monitorRunning = false;

export function startFeedHealthMonitor(deps: FeedHealthDeps): void {
  if (monitorRunning) return;
  monitorRunning = true;

  const check = async () => {
    const now = Date.now();

    await checkFeed({
      name: 'X feed',
      serviceName: 'nanoclaw-x-feed',
      getLatest: () => getLatestCollectedAt('x_feed_tweets'),
      thresholdMs: X_FEED_STALE_THRESHOLD_MS,
      alertKey: 'feed_health:x_feed_alerted',
      now,
      sendAlert: deps.sendAlert,
    });

    await checkFeed({
      name: 'Substack feed',
      serviceName: 'nanoclaw-substack-feed',
      getLatest: () => getLatestCollectedAt('substack_feed_posts'),
      thresholdMs: SUBSTACK_FEED_STALE_THRESHOLD_MS,
      alertKey: 'feed_health:substack_alerted',
      now,
      sendAlert: deps.sendAlert,
    });
  };

  // First check after 60s (let channels connect), then every 30min
  setTimeout(check, 60_000);
  setInterval(check, FEED_HEALTH_CHECK_INTERVAL);
  logger.info('Feed health monitor started');
}
