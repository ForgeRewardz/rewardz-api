// SBL Markets HTTP client — thin typed wrapper around markets.dial.to.
//
// Used by:
//   * Task 17 provider-catalog snapshot service (daily cron)
//   * Task 19 GET /v1/providers/:slug/vaults (live, stale-while-revalidate)
//
// Env contract (see config.ts):
//   DIALECT_CLIENT_KEY  — production prod-key from hello@dialect.to.
//                         Empty string allowed at boot for local dev; client
//                         throws at request time if the key is empty.
//
// Action URL normalisation: SBL returns blink URLs prefixed with 'blink:'
// (e.g. 'blink:https://kamino-action.dial.to/v1/lend?...'). Downstream code
// (mini-app, protocol-console) consumes the bare https URL — this client
// strips the 'blink:' prefix on the way out.

const SBL_BASE_URL = "https://markets.dial.to";
const DEFAULT_TIMEOUT_MS = 10_000; // 10s — markets.dial.to median is ~300ms;
// anything over 10s is a signal of an upstream incident.
const DEFAULT_RETRIES = 2; // total attempts = 1 + retries; backoff is fixed
// since SBL doesn't expose Retry-After.
const RETRY_BASE_DELAY_MS = 250;

// Minimal typed shapes — capture ONLY fields we consume.
export interface SblMarketAction {
  vaultId: string;
  blinkUrl: string; // post-strip ('blink:' prefix removed)
  title?: string;
  // Catch-all for fields we don't yet model (provider may extend in future).
  [k: string]: unknown;
}

export interface SblMarketProvider {
  slug: string;
  displayName: string;
  actions: SblMarketAction[];
  // SBL also exposes things like 'logoUrl', 'category' — not modelled until needed.
  [k: string]: unknown;
}

export interface SblMarketsResponse {
  // The Markets API returns a flat array of providers per action type.
  providers: SblMarketProvider[];
  [k: string]: unknown;
}

export interface SblPosition {
  provider: string; // slug
  vaultId: string;
  value: string; // SBL uses string for big numbers
  lastUpdated: string; // ISO 8601
  [k: string]: unknown;
}

export interface SblPositionsResponse {
  positions: SblPosition[];
  [k: string]: unknown;
}

export interface SblFetchOptions {
  timeoutMs?: number;
  retries?: number;
}

// Internal: wrap fetch with timeout via AbortSignal + a basic retry loop.
async function sblFetch(
  pathAndQuery: string,
  apiKey: string,
  options: SblFetchOptions = {},
): Promise<unknown> {
  if (!apiKey) {
    throw new Error(
      "DIALECT_CLIENT_KEY is empty; request the prod key from hello@dialect.to (see docs/ops/dialect-key.md)",
    );
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const totalRetries = options.retries ?? DEFAULT_RETRIES;
  const url = `${SBL_BASE_URL}${pathAndQuery}`;

  let lastError: unknown;
  for (let attempt = 0; attempt <= totalRetries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "x-dialect-client-key": apiKey,
          accept: "application/json",
        },
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        // Retry on 5xx; bail on 4xx so we surface auth / quota errors fast.
        if (res.status >= 500 && attempt < totalRetries) {
          lastError = new Error(`SBL ${pathAndQuery} ${res.status}`);
        } else {
          throw new Error(
            `SBL ${pathAndQuery} ${res.status} ${res.statusText}`,
          );
        }
      } else {
        return await res.json();
      }
    } catch (err) {
      clearTimeout(timer);
      // Abort errors and network errors are retryable up to the cap.
      if (attempt < totalRetries) {
        lastError = err;
      } else {
        throw err;
      }
    }
    // Linear backoff (no jitter — keep this simple; markets.dial.to is internal-ish).
    await new Promise((resolve) =>
      setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)),
    );
  }
  throw (
    lastError ??
    new Error(`SBL ${pathAndQuery} failed after ${totalRetries + 1} attempts`)
  );
}

// Strip the 'blink:' prefix SBL puts on action URLs.
function stripBlinkPrefix(url: string): string {
  return url.startsWith("blink:") ? url.slice("blink:".length) : url;
}

function normaliseProvider(p: SblMarketProvider): SblMarketProvider {
  return {
    ...p,
    actions: (p.actions ?? []).map((a) => ({
      ...a,
      blinkUrl: stripBlinkPrefix(a.blinkUrl),
    })),
  };
}

export async function fetchMarkets(
  actionType: string,
  apiKey: string,
  options?: SblFetchOptions,
): Promise<SblMarketsResponse> {
  const raw = (await sblFetch(
    `/api/v0/markets?actionType=${encodeURIComponent(actionType)}`,
    apiKey,
    options,
  )) as SblMarketsResponse;
  return {
    ...raw,
    providers: (raw.providers ?? []).map(normaliseProvider),
  };
}

export async function fetchPositions(
  wallet: string,
  apiKey: string,
  options?: SblFetchOptions,
): Promise<SblPositionsResponse> {
  return (await sblFetch(
    `/api/v0/positions?wallet=${encodeURIComponent(wallet)}`,
    apiKey,
    options,
  )) as SblPositionsResponse;
}

// Test-only export so the unit tests in api/tests/services/ (Task 40) can
// assert the prefix-stripping logic in isolation without going through
// the full fetch path.
export const __testing = { stripBlinkPrefix, normaliseProvider };
