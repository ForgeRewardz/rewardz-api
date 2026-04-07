import { config } from "../config.js";

/* -------------------------------------------------------------------------- */
/*  Types                                                                     */
/* -------------------------------------------------------------------------- */

export interface TweetVerificationResult {
  verified: boolean;
  tweet_id: string;
  author_id?: string;
  metrics?: { likes: number; retweets: number };
  points_earned?: number;
  reason?: string;
}

/* -------------------------------------------------------------------------- */
/*  URL parsing                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Extract the tweet ID from a twitter.com or x.com URL.
 *
 * Supported formats:
 * - https://twitter.com/user/status/1234567890
 * - https://x.com/user/status/1234567890
 * - https://www.twitter.com/user/status/1234567890?s=20
 * - https://mobile.twitter.com/user/status/1234567890
 */
export function parseTweetUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.replace(/^(www\.|mobile\.)/, "");

    if (hostname !== "twitter.com" && hostname !== "x.com") {
      return null;
    }

    // Path format: /<user>/status/<tweet_id>
    const match = parsed.pathname.match(/\/\w+\/status\/(\d+)/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/*  Verification                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Verify a tweet against a verification rule.
 *
 * When TWITTER_BEARER_TOKEN is configured, returns a mock successful
 * verification (actual Twitter API v2 integration to be added later).
 * When not configured, returns a failure indicating the API is not set up.
 */
export async function verifyTweet(
  tweetUrl: string,
  _ruleId: string,
): Promise<TweetVerificationResult> {
  const tweetId = parseTweetUrl(tweetUrl);

  if (!tweetId) {
    return {
      verified: false,
      tweet_id: "",
      reason: "Invalid tweet URL format",
    };
  }

  if (!config.TWITTER_BEARER_TOKEN) {
    return {
      verified: false,
      tweet_id: tweetId,
      reason: "Twitter API not configured",
    };
  }

  // Stub: return mock successful verification
  // Actual Twitter API v2 call will replace this block
  return {
    verified: true,
    tweet_id: tweetId,
    author_id: "mock_author_id",
    metrics: { likes: 0, retweets: 0 },
    points_earned: 100,
  };
}
