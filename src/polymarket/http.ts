export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly url: string,
    readonly body: string,
  ) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 300)}`);
    this.name = "HttpError";
  }
}

export interface GetOptions {
  timeoutMs?: number;
  retries?: number;
  signal?: AbortSignal;
}

const RETRYABLE = new Set([408, 425, 429, 500, 502, 503, 504]);

/**
 * GET JSON with bounded retries. Polymarket's public endpoints rate-limit and
 * occasionally 502 under load; a scan that dies on the first blip is useless.
 */
export async function getJson<T>(
  url: string,
  opts: GetOptions = {},
): Promise<T> {
  const { timeoutMs = 20_000, retries = 3 } = opts;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      // 500ms, 1s, 2s, ... with jitter so concurrent scanners don't sync up.
      const backoff = 500 * 2 ** (attempt - 1);
      await sleep(backoff + Math.random() * 250);
    }

    const timer = new AbortController();
    const timeout = setTimeout(() => timer.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { accept: "application/json", "user-agent": "poly-research/0.1" },
        signal: opts.signal ?? timer.signal,
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const err = new HttpError(res.status, url, body);
        if (RETRYABLE.has(res.status) && attempt < retries) {
          lastError = err;
          continue;
        }
        throw err;
      }

      return (await res.json()) as T;
    } catch (err) {
      // Network errors and timeouts are retryable; HttpError already decided.
      if (err instanceof HttpError) throw err;
      lastError = err;
      if (attempt >= retries) break;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw new Error(`GET ${url} failed after ${retries + 1} attempts: ${String(lastError)}`);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run `worker` over `items` with at most `limit` in flight. */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const index = cursor++;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T, index);
    }
  });

  await Promise.all(runners);
  return results;
}
