/**
 * X Feed Monitor - Tweet filtering
 *
 * Matches tweets against watchlist accounts, ticker patterns, and keywords.
 */

import { XFeedConfig } from './x-feed-config.js';
import { TweetData } from './x-feed-browser.js';

export type { TweetData };

export interface FilteredTweet extends TweetData {
  matchReasons: string[];
  tickers: string[];
}

export function filterTweets(
  tweets: TweetData[],
  config: XFeedConfig,
  isSeen: (url: string) => boolean,
): FilteredTweet[] {
  const tickerRegex = config.tickerPattern
    ? new RegExp(config.tickerPattern, 'g')
    : null;

  const watchlistLower = config.watchlistAccounts.map((a) =>
    a.toLowerCase().replace(/^@/, ''),
  );

  const keywordsLower = config.keywords.map((k) => k.toLowerCase());

  const results: FilteredTweet[] = [];

  for (const tweet of tweets) {
    if (!tweet.url || !tweet.text || isSeen(tweet.url)) continue;

    const reasons: string[] = [];
    let tickers: string[] = [];

    // Check watchlist accounts
    const handleLower = (tweet.handle || tweet.author)
      .toLowerCase()
      .replace(/^@/, '');
    if (
      watchlistLower.length > 0 &&
      watchlistLower.some((w) => handleLower.includes(w))
    ) {
      reasons.push(`watchlist: @${handleLower}`);
    }

    // Check tickers
    if (tickerRegex) {
      tickerRegex.lastIndex = 0;
      const matches = tweet.text.match(tickerRegex);
      if (matches && matches.length > 0) {
        tickers = [...new Set(matches)];
        reasons.push(`tickers: ${tickers.join(', ')}`);
      }
    }

    // Check keywords
    const textLower = tweet.text.toLowerCase();
    const matchedKeywords = keywordsLower.filter((k) => textLower.includes(k));
    if (matchedKeywords.length > 0) {
      reasons.push(`keywords: ${matchedKeywords.join(', ')}`);
    }

    if (reasons.length > 0) {
      results.push({ ...tweet, matchReasons: reasons, tickers });
    }
  }

  return results;
}
