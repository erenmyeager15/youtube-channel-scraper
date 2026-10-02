import { gotScraping } from 'got-scraping';

import { RequestBudget, readBoundedBody } from './request-budget.js';
import { getYouTubeSession } from './youtube-session.js';

interface HttpOptions {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
  proxyUrl?: string;
  maximumResponseBytes?: number;
  maximumRedirects?: number;
}

interface PublicResponse {
  statusCode: number;
  url: string;
}

export interface HttpStream extends AsyncIterable<Uint8Array | string> {
  on(event: 'response', listener: (response: PublicResponse) => void): unknown;
  destroy(): unknown;
}

export type StreamFactory = (options: Record<string, any>) => HttpStream;

export function assertPublicYouTubeUrl(value: string | URL): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['www.youtube.com', 'youtube.com', 'm.youtube.com'].includes(url.hostname)
    || url.username || url.password || url.port) {
    throw new Error('Only public HTTPS YouTube requests are supported.');
  }
}

/** Return limit errors through Got's cause wrapper without exposing tokens/proxy URLs. */
export function transportLimitReason(error: unknown): string | null {
  let current: any = error;
  for (let depth = 0; current && depth < 8; depth += 1, current = current.cause) {
    if (['request-limit', 'time-limit', 'response-size'].includes(current.reason)) return current.reason;
  }
  return null;
}

export async function fetchBoundedHttp(
  options: HttpOptions,
  budget: RequestBudget,
  openStream: StreamFactory = (request) => gotScraping.stream(request),
): Promise<PublicResponse & { body: string }> {
  assertPublicYouTubeUrl(options.url);
  const { maximumResponseBytes = 8 * 1024 * 1024, maximumRedirects = 3, ...requestOptions } = options;
  if (!Number.isSafeInteger(maximumResponseBytes) || maximumResponseBytes < 1 || maximumResponseBytes > 8 * 1024 * 1024
    || !Number.isInteger(maximumRedirects) || maximumRedirects < 0 || maximumRedirects > 3) {
    throw new Error('Invalid bounded HTTP limits.');
  }
  budget.check();
  let response: PublicResponse | undefined;
  let stream: HttpStream | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const destroySafely = () => { try { stream?.destroy(); } catch { /* Cleanup must not expose transport secrets. */ } };
  try {
    const remainingMs = budget.remainingTimeMs();
    const timeoutMs = Math.min(30_000, remainingMs);
    const deadlineReached = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('Public HTTP wait exceeded its deadline.'), {
          reason: remainingMs <= 30_000 ? 'time-limit' : 'request-timeout',
        }));
        controller.abort();
        destroySafely();
      }, timeoutMs);
    });
    stream = openStream({
      ...requestOptions,
      sessionToken: getYouTubeSession(budget).headerToken,
      signal: controller.signal,
      timeout: { request: timeoutMs },
      retry: { limit: 0 },
      throwHttpErrors: false,
      followRedirect: true,
      maxRedirects: maximumRedirects,
      decompress: true,
      hooks: {
        beforeRequest: [(request: any) => {
          assertPublicYouTubeUrl(request.url);
          request.timeout.request = budget.take();
        }],
        beforeRedirect: [(request: any) => assertPublicYouTubeUrl(request.url)],
      },
    });
    stream.on('response', (value) => { response = value; });
    const activeStream = stream;
    const checkedChunks = async function* () {
      for await (const chunk of activeStream) {
        budget.checkTime();
        yield chunk;
      }
    };
    // Got preflight hooks run before its own request timer. This outer wait covers them too.
    const body = await Promise.race([readBoundedBody(checkedChunks(), maximumResponseBytes), deadlineReached]);
    budget.checkTime();
    if (!response) throw new Error('YouTube response headers were unavailable.');
    assertPublicYouTubeUrl(response.url);
    return { statusCode: response.statusCode, url: response.url, body };
  } catch (error) {
    const reason = transportLimitReason(error);
    if (reason) throw Object.assign(new Error(`YouTube transport stopped: ${reason}.`), { reason });
    throw new Error('YouTube HTTP transport failed.');
  } finally {
    if (timer) clearTimeout(timer);
    destroySafely();
  }
}
